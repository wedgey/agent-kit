import { afterEach, beforeEach, describe, it } from "node:test";
import { expect } from "./expect.mjs";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFLICT_EXIT,
  HELD_ENV,
  PROTOCOL_VERSION,
  START_FD,
  TIMEOUT_EXIT,
  activity,
  allQueues,
  backoffMs,
  claimableSlots,
  bypassNotice,
  bypassReason,
  detectFlock,
  ensureDir,
  execUnderLock,
  exitCodeFor,
  flockArgs,
  formatAge,
  childStdio,
  findLockFd,
  freshTickets,
  isFreshTicket,
  pollCeilingMs,
  queueSnapshot,
  holderLine,
  isConflict,
  isDirectInvocation,
  isLive,
  listHolders,
  listTickets,
  main,
  orderTickets,
  parseRunArgs,
  pidAlive,
  staleAfterMs,
  processStartTime,
  queueDir,
  queueStatus,
  readJson,
  resolveSlots,
  run,
  runDirect,
  sleepSync,
  snapshotProc,
  stateDir,
  statusText,
  timeoutNotice,
  treeTicks,
  truncate,
  validQueueName,
  waitNotice,
  waiterLine,
  withActivity,
} from "../../skills/conductor/tools/queue.mjs";

const QUEUE_MJS = fileURLToPath(new URL("../../skills/conductor/tools/queue.mjs", import.meta.url));
let tmp;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "queue-test-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const alive = (t) => ({ ...t, startTime: processStartTime(process.pid), pid: process.pid, ...t });

describe("state dir and slot count", () => {
  it("prefers CONDUCTOR_QUEUE_DIR, then XDG_STATE_HOME, then ~/.local/state", () => {
    expect(stateDir({ CONDUCTOR_QUEUE_DIR: "/q", XDG_STATE_HOME: "/x" }, "/h")).toBe("/q");
    expect(stateDir({ XDG_STATE_HOME: "/x" }, "/h")).toBe("/x/conductor-queue");
    expect(stateDir({}, "/h")).toBe("/h/.local/state/conductor-queue");
    expect(stateDir({})).toMatch(/conductor-queue$/);
  });

  it("nests everything under the protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(queueDir({ CONDUCTOR_QUEUE_DIR: "/q" }, "tests")).toBe("/q/v1/tests");
  });

  it("validates queue names", () => {
    expect(validQueueName("e2e-1_a")).toBe(true);
    for (const bad of ["", "../x", "a b", "a/b"]) expect(validQueueName(bad)).toBe(false);
  });

  it("resolves flag, then the queue's env, then 1, ignoring non-positive values", () => {
    const env = { CONDUCTOR_QUEUE_SLOTS_E2E_X: "3" };
    expect(resolveSlots({ flag: "2", env, queue: "e2e-x" })).toBe(2);
    expect(resolveSlots({ env, queue: "e2e-x" })).toBe(3);
    expect(resolveSlots({ env, queue: "other" })).toBe(1);
    expect(resolveSlots({ flag: "0", env: { CONDUCTOR_QUEUE_SLOTS_Q: "-4" }, queue: "q" })).toBe(1);
    expect(resolveSlots({ flag: "many", queue: "q" })).toBe(1);
  });
});

describe("ranking and admission", () => {
  const t = (priority, createdAt, pid) => ({ priority, createdAt, pid });

  it("puts gate before normal, then oldest, then lowest pid", () => {
    const sorted = orderTickets([t("normal", 1, 5), t("gate", 9, 7), t("normal", 1, 2), t("normal", 0, 9), t("odd", 1, 1)]);
    expect(sorted.map((x) => [x.priority, x.createdAt, x.pid])).toEqual([
      ["gate", 9, 7],
      ["normal", 0, 9],
      ["odd", 1, 1],
      ["normal", 1, 2],
      ["normal", 1, 5],
    ]);
  });

  it("does not mutate its input", () => {
    const input = [t("normal", 2, 1), t("gate", 1, 2)];
    orderTickets(input);
    expect(input[0].priority).toBe("normal");
  });

  it("hands a rank-0 waiter every slot it may use, free or not", () => {
    expect(claimableSlots({ ahead: [], free: [], mine: [0, 1] })).toEqual([0, 1]);
  });

  it("gives each waiter ahead the lowest free slot it can use, and leaves the rest", () => {
    expect(claimableSlots({ ahead: [{ slots: 2 }], free: [0, 1], mine: [0, 1] })).toEqual([1]);
    expect(claimableSlots({ ahead: [{ slots: 2 }, { slots: 2 }], free: [0, 1], mine: [0, 1] })).toEqual([]);
    expect(claimableSlots({ ahead: [{ slots: 1 }], free: [1], mine: [0, 1] })).toEqual([1]);
    expect(claimableSlots({ ahead: [{ slots: 1 }], free: [0], mine: [0] })).toEqual([]);
    expect(claimableSlots({ ahead: [{}], free: [0], mine: [0] })).toEqual([]);
  });

  it("uses a waiter's usable list over its slot count", () => {
    expect(claimableSlots({ ahead: [{ slots: 2, usable: [0] }], free: [0, 1], mine: [0, 1] })).toEqual([1]);
    expect(claimableSlots({ ahead: [{ slots: 2, usable: [] }], free: [0, 1], mine: [0, 1] })).toEqual([0, 1]);
  });

  it("only offers slots the caller allows", () => {
    expect(claimableSlots({ ahead: [{ slots: 1 }], free: [0, 1], mine: [0] })).toEqual([]);
    expect(claimableSlots({ ahead: [{ slots: 1 }], free: [1, 2], mine: [2] })).toEqual([2]);
  });

  it("judges staleness by each ticket's own poll interval, with a floor", () => {
    expect(staleAfterMs({})).toBe(6000);
    expect(staleAfterMs({ pollMs: 100 })).toBe(6000);
    expect(staleAfterMs({ pollMs: 10_000 })).toBe(30_000);
    expect(pollCeilingMs({})).toBe(2000);
    expect(pollCeilingMs({ CONDUCTOR_QUEUE_POLL_MS: "10000" })).toBe(10_000);
    const t = [{ mtimeMs: 100 }, { mtimeMs: 995_000, pollMs: 10_000 }, { mtimeMs: 995_000 }];
    expect(freshTickets(t, 1_000_000)).toEqual([{ mtimeMs: 995_000, pollMs: 10_000 }, { mtimeMs: 995_000 }]);
    expect(isFreshTicket({ mtimeMs: 1 }, 7000)).toBe(false);
  });
});

describe("liveness", () => {
  it("is live only for the same pid and start time", () => {
    const rec = { pid: 4, startTime: 10 };
    expect(isLive(rec, () => 10)).toBe(true);
    expect(isLive(rec, () => 11)).toBe(false);
    expect(isLive(rec, () => null)).toBe(false);
    expect(isLive({ pid: 4, startTime: null }, () => null, () => false)).toBe(false);
    expect(isLive({ pid: "x", startTime: 1 }, () => 1)).toBe(false);
    expect(isLive(null)).toBe(false);
  });

  // Where /proc is absent (macOS) no start time exists, so a bare pid check is the best liveness there is.
  it("falls back to a pid check when no start time was recorded", () => {
    expect(isLive({ pid: 4, startTime: null }, () => null, () => true)).toBe(true);
    expect(isLive({ pid: 4 }, () => null, (pid) => pid === 4)).toBe(true);
  });

  it("probes a pid with signal 0, counting EPERM as alive", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 + 1)).toBe(false);
    expect(pidAlive(5, () => { throw Object.assign(new Error("x"), { code: "EPERM" }); })).toBe(true);
  });

  it("reads field 22 even when comm holds spaces and parentheses", () => {
    const rest = Array.from({ length: 50 }, (_, i) => String(i + 3)).join(" ");
    expect(processStartTime(1, () => `1 (a b) (c)) ${rest}`)).toBe(22);
    expect(typeof processStartTime(process.pid)).toBe("number");
    expect(processStartTime(2 ** 22 + 1)).toBeNull();
    expect(processStartTime(1, () => "1 (x) S")).toBeNull();
  });

  it("readJson is null for missing or corrupt files", () => {
    expect(readJson(path.join(tmp, "nope"))).toBeNull();
    expect(readJson("/f", () => "{bad")).toBeNull();
    expect(readJson("/f", () => '{"a":1}')).toEqual({ a: 1 });
  });
});

describe("tickets and holders on disk", () => {
  it("lists live tickets in order with their mtime, and prunes dead ones", () => {
    const dir = path.join(tmp, "q");
    mkdirSync(path.join(dir, "tickets"), { recursive: true });
    const w = (name, rec) => writeFileSync(path.join(dir, "tickets", name), JSON.stringify(rec));
    w(`normal-2-${process.pid}.json`, alive({ priority: "normal", createdAt: 2 }));
    w(`gate-5-${process.pid}.json`, alive({ priority: "gate", createdAt: 5 }));
    w("gate-1-999999.json", { pid: 999999, startTime: 1, priority: "gate", createdAt: 1 });
    const got = listTickets(dir);
    expect(got.map((x) => x.priority)).toEqual(["gate", "normal"]);
    expect(got[0].mtimeMs).toBeGreaterThan(0);
    expect(readdirSync(path.join(dir, "tickets")).sort()).toEqual([`gate-5-${process.pid}.json`, `normal-2-${process.pid}.json`]);
    expect(listTickets(path.join(tmp, "absent"))).toEqual([]);
  });

  // A ticket read mid-write is empty; deleting it would drop a live waiter from the line.
  it("never deletes an unparseable ticket whose pid is alive, and ranks it from its file name", () => {
    const dir = path.join(tmp, "q");
    mkdirSync(path.join(dir, "tickets"), { recursive: true });
    const name = `gate-7-${process.pid}.json`;
    writeFileSync(path.join(dir, "tickets", name), "");
    writeFileSync(path.join(dir, "tickets", "normal-3-999999.json"), "{");
    writeFileSync(path.join(dir, "tickets", ".gate-7.tmp"), "half");
    const got = listTickets(dir);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ pid: process.pid, priority: "gate", createdAt: 7, slots: 1 });
    expect(readdirSync(path.join(dir, "tickets")).sort()).toEqual([".gate-7.tmp", name]);
  });

  it("keeps a stale-but-live ticket listed so it can be skipped, not deleted", () => {
    const dir = path.join(tmp, "q");
    mkdirSync(path.join(dir, "tickets"), { recursive: true });
    const file = path.join(dir, "tickets", `normal-1-${process.pid}.json`);
    writeFileSync(file, JSON.stringify(alive({ priority: "normal", createdAt: 1 })));
    utimesSync(file, 1, 1);
    expect(freshTickets(listTickets(dir), Date.now())).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });

  it("lists live holders by slot, reading a dead one as free", () => {
    const dir = path.join(tmp, "q");
    mkdirSync(path.join(dir, "holders"), { recursive: true });
    const w = (name, rec) => writeFileSync(path.join(dir, "holders", name), JSON.stringify(rec));
    w("slot-1.json", alive({ cwd: "/b" }));
    w("slot-0.json", alive({ cwd: "/a" }));
    w("slot-2.json", { pid: 999999, startTime: 1 });
    w("notes.json", alive({}));
    expect(listHolders(dir).map((h) => [h.slot, h.cwd])).toEqual([[0, "/a"], [1, "/b"]]);
    expect(listHolders(path.join(tmp, "absent"))).toEqual([]);
  });
});

describe("process-tree activity", () => {
  const procs = {
    pids: () => ["1", "2", "3", "4"],
    stat: (pid) => {
      const row = { 1: [0, 5, 5], 2: [1, 1, 1], 3: [2, 10, 0], 4: [9, 7, 7] }[pid];
      const f = Array(13).fill("0");
      f[1] = String(row[0]);
      f[11] = String(row[1]);
      f[12] = String(row[2]);
      return `${pid} (a (b)) ${f.join(" ")}`;
    },
  };

  it("sums the pid and its descendants only", () => {
    const snap = snapshotProc(procs);
    expect(treeTicks(snap, 2)).toBe(2 + 10);
    expect(treeTicks(snap, 1)).toBe(10 + 2 + 10 + 0);
    expect(treeTicks(snap, 77)).toBeNull();
    expect(treeTicks(null, 1)).toBeNull();
  });

  it("skips processes that vanish mid-scan and reads a failed listing as null", () => {
    const flaky = { pids: () => ["1", "2"], stat: (pid) => { if (pid === "2") throw new Error("ESRCH"); return procs.stat(pid); } };
    expect(snapshotProc(flaky).size).toBe(1);
    expect(snapshotProc({ pids: () => { throw new Error("EACCES"); } })).toBeNull();
    expect(snapshotProc().has(process.pid)).toBe(true);
  });

  it("calls equal samples idle, different busy, and unreadable unknown", () => {
    expect(activity(5, 5)).toBe("idle");
    expect(activity(5, 6)).toBe("busy");
    expect(activity(null, 5)).toBe("unknown");
    expect(activity(5, null)).toBe("unknown");
    expect(activity(NaN, 5)).toBe("unknown");
  });

  it("samples twice around a sleep, and never reports idle without /proc", () => {
    let calls = 0;
    const moving = {
      pids: procs.pids,
      stat: (pid) => (pid === "3" && calls++ > 0 ? procs.stat(pid).replace(/ 10 0$/, " 11 0") : procs.stat(pid)),
    };
    const slept = [];
    const [h] = withActivity([{ pid: 3 }], { proc: moving, sleep: (ms) => slept.push(ms), gapMs: 5 });
    expect(slept).toEqual([5]);
    expect(h.state).toBe("busy");
    const [still] = withActivity([{ pid: 3 }], { proc: procs, sleep: () => {} });
    expect(still.state).toBe("idle");
    const dead = { pids: () => { throw new Error("no proc"); } };
    expect(withActivity([{ pid: 3 }], { proc: dead, sleep: () => {} })[0].state).toBe("unknown");
    expect(withActivity([])).toEqual([]);
  });
});

describe("formatting", () => {
  it("formats ages", () => {
    expect(formatAge(-5)).toBe("0s");
    expect(formatAge(42_000)).toBe("42s");
    expect(formatAge(125_000)).toBe("2m05s");
    expect(formatAge(3 * 3600_000 + 7 * 60_000)).toBe("3h07m");
  });

  it("truncates long commands", () => {
    expect(truncate("abc", 5)).toBe("abc");
    expect(truncate("abcdef", 5)).toBe("abcd…");
  });

  it("renders holder and waiter lines", () => {
    const h = { slot: 1, state: "idle", acquiredAt: 0, cwd: "/r", command: "pnpm test" };
    expect(holderLine(h, 61_000)).toBe("slot 1: idle, 1m01s, /r, pnpm test");
    expect(holderLine({ ...h, state: undefined }, 0)).toContain("unknown");
    expect(waiterLine({ priority: "gate", createdAt: 0, cwd: "/w", command: "x" }, 0, 5000)).toBe("#1 gate: 5s, /w, x");
  });

  it("prints status text for empty, held and waiting queues", () => {
    expect(statusText([])).toBe("no queues yet\n");
    const q = {
      name: "tests",
      slots: 2,
      slotsSource: "records",
      holders: [{ slot: 0, state: "busy", acquiredAt: 0, cwd: "/a", command: "c" }],
      waiters: [{ priority: "normal", createdAt: 0, cwd: "/b", command: "d" }],
    };
    expect(statusText([{ ...q, slotsSource: "files" }], 1000)).toContain("2 slot file(s)");
    expect(statusText([q], 1000)).toBe(
      "tests: 2 slot(s), 1 held, 1 waiting\n  slot 0: busy, 1s, /a, c\n  #1 normal: 1s, /b, d\n",
    );
  });

  it("builds a wait notice naming the holders and the hint", () => {
    const n = waitNotice({
      tag: "[t]",
      label: "a slot",
      hint: "Raise X.",
      slotCount: 2,
      waitedMs: 31_000,
      rank: 2,
      holders: [{ slot: 0, state: "idle", acquiredAt: 0, cwd: "/a", command: "c" }],
      now: 1000,
    });
    expect(n).toMatch(/^\[t\] waiting for a slot: all 2 in use box-wide, you are #3 in line \(31s\)/);
    expect(n).toContain("slot 0: idle");
    expect(n).toContain("Raise X.");
    expect(waitNotice({ tag: "[t]", label: "l", slotCount: 1, waitedMs: 3, rank: 0, holders: [] })).not.toMatch(/\(0s\)/);
  });

  it("says the queue is full on timeout", () => {
    expect(timeoutNotice({ tag: "[t]", label: "a slot", waitedMs: 2000, slotCount: 1 })).toMatch(/queue full: gave up waiting for a slot after 2s.*Not running/);
  });
});

describe("queue status", () => {
  it("reports slots, live holders with activity, and ordered waiters", () => {
    const dir = path.join(tmp, "v1", "q");
    mkdirSync(path.join(dir, "holders"), { recursive: true });
    mkdirSync(path.join(dir, "tickets"), { recursive: true });
    writeFileSync(path.join(dir, "slot-0"), "");
    writeFileSync(path.join(dir, "slot-1"), "");
    writeFileSync(path.join(dir, "holders", "slot-0.json"), JSON.stringify(alive({ acquiredAt: 10, cwd: "/h", command: "c", slots: 3 })));
    writeFileSync(path.join(dir, "tickets", `normal-20-${process.pid}.json`), JSON.stringify(alive({ priority: "normal", createdAt: 20, slots: 2 })));
    const q = queueStatus(dir, "q", { now: 100, sleep: () => {} });
    expect(q).toMatchObject({ name: "q", slots: 3, slotsSource: "records" });
    expect(q.holders[0]).toMatchObject({ slot: 0, ageMs: 90 });
    expect(["idle", "busy"]).toContain(q.holders[0].state);
    expect(q.waiters[0]).toMatchObject({ rank: 0, waitedMs: 80 });
    expect(queueStatus(path.join(tmp, "none"), "none")).toEqual({ name: "none", slots: 0, slotsSource: "files", holders: [], waiters: [] });
    rmSync(path.join(dir, "holders", "slot-0.json"));
    rmSync(path.join(dir, "tickets"), { recursive: true });
    expect(queueStatus(dir, "q")).toMatchObject({ slots: 2, slotsSource: "files" });
    expect(allQueues({ CONDUCTOR_QUEUE_DIR: tmp }, { sleep: () => {} }).map((x) => x.name)).toEqual(["q"]);
    expect(allQueues({ CONDUCTOR_QUEUE_DIR: path.join(tmp, "absent") })).toEqual([]);
  });
});

describe("queue snapshot", () => {
  const setup = () => {
    const dir = path.join(tmp, "v1", "s");
    mkdirSync(path.join(dir, "holders"), { recursive: true });
    mkdirSync(path.join(dir, "tickets"), { recursive: true });
    for (const n of [0, 1, 2]) writeFileSync(path.join(dir, `slot-${n}`), "");
    writeFileSync(path.join(dir, "holders", "slot-0.json"), JSON.stringify(alive({ acquiredAt: 5, cwd: "/h", command: "c", slots: 3 })));
    return dir;
  };
  const busy = (slots) => (cmd, args) => ({ status: slots.some((n) => args[1].endsWith(`slot-${n}`)) ? 1 : 0 });

  it("reports a held lock with no live record as an orphaned holder, and skips recorded slots", () => {
    const dir = setup();
    const probed = [];
    const spawn = (cmd, args) => { probed.push(args[1]); return busy([1])(cmd, args); };
    const snap = queueSnapshot(dir, { sample: false, spawn, now: 10 });
    expect(snap.holders.map((h) => [h.slot, h.orphan ?? false])).toEqual([[0, false], [1, true]]);
    expect(probed.map((f) => path.basename(f))).toEqual(["slot-1", "slot-2"]);
    expect(holderLine(snap.holders[1])).toBe("slot 1: held (no record; orphaned run)");
    expect(snap.holders[0].state).toBeUndefined();
    expect(snap).toMatchObject({ slots: 3, slotsSource: "records" });
  });

  it("does not read a missing flock or a free lock as an orphan", () => {
    const dir = setup();
    expect(queueSnapshot(dir, { sample: false, spawn: () => ({ status: null, error: new Error("ENOENT") }) }).holders).toHaveLength(1);
    expect(queueSnapshot(dir, { sample: false, spawn: busy([]) }).holders).toHaveLength(1);
  });

  it("stops probing when the budget is spent", () => {
    const dir = setup();
    expect(queueSnapshot(dir, { sample: false, spawn: busy([1, 2]), budgetMs: -1 }).holders).toHaveLength(1);
  });

  it("hides stale waiters without deleting them, and samples activity unless told not to", () => {
    const dir = setup();
    const t = (n, mtime) => {
      const f = path.join(dir, "tickets", `normal-${n}-${process.pid}.json`);
      writeFileSync(f, JSON.stringify(alive({ priority: "normal", createdAt: n })));
      if (mtime) utimesSync(f, mtime, mtime);
    };
    t(1, 1);
    const order = [];
    const sleep = () => order.push(readdirSync(path.join(dir, "tickets")).length);
    const snap = queueSnapshot(dir, { spawn: busy([]), sleep });
    expect(snap.waiters).toEqual([]);
    expect(["idle", "busy", "unknown"]).toContain(snap.holders[0].state);
    expect(order).toEqual([1]);
    const quiet = queueSnapshot(dir, { sample: false, spawn: busy([]) });
    expect(quiet.holders[0].state).toBeUndefined();
  });
});

describe("flock plumbing", () => {
  it("builds a non-blocking attempt that runs exec mode, not the command", () => {
    const args = flockArgs({ slot: "/s", nodePath: "/n", modulePath: "/m", execArgs: ["--holder=h"], command: ["x", "y"] });
    expect(args).toEqual(["-n", "-E", "200", "/s", "/n", "/m", "--exec", "--holder=h", "--", "x", "y"]);
  });

  // A wrapped command exiting with the conflict code must not read as a busy slot: it would be run again in a loop.
  it("treats the conflict code as busy only when nothing was announced on fd 3", () => {
    expect(START_FD).toBe(3);
    expect(isConflict({ status: CONFLICT_EXIT, output: [null, null, null, Buffer.alloc(0)] })).toBe(true);
    expect(isConflict({ status: CONFLICT_EXIT, output: [null, null, null, Buffer.from("1")] })).toBe(false);
    expect(isConflict({ status: CONFLICT_EXIT })).toBe(true);
    expect(isConflict({ status: 1, output: [] })).toBe(false);
    expect(isConflict(undefined)).toBe(false);
  });

  it("spells exit codes like a shell", () => {
    expect(exitCodeFor({ status: 3 })).toBe(3);
    expect(exitCodeFor({ signal: "SIGKILL" }, { SIGKILL: 9 })).toBe(137);
    expect(exitCodeFor({ signal: "SIGX" }, {})).toBe(128);
    expect(exitCodeFor({})).toBe(1);
    expect(exitCodeFor(undefined)).toBe(1);
  });

  it("detects flock", () => {
    expect(detectFlock(() => ({ status: 0 }))).toBe(true);
    expect(detectFlock(() => ({ error: new Error("ENOENT") }))).toBe(false);
    expect(detectFlock(() => ({ status: 1 }))).toBe(false);
  });

  it("checks writability, not just existence", () => {
    const boom = () => { throw new Error("EACCES"); };
    expect(ensureDir("/x", { mkdir: () => {}, access: () => {} })).toBe(true);
    expect(ensureDir("/x", { mkdir: boom, access: () => {} })).toBe(false);
    expect(ensureDir("/x", { mkdir: () => {}, access: boom })).toBe(false);
    expect(ensureDir(path.join(tmp, "a", "b"))).toBe(true);
  });

  it("matches direct invocation across percent-encoding", () => {
    expect(isDirectInvocation("/r/q.mjs", "file:///r/q.mjs")).toBe(true);
    expect(isDirectInvocation("/tmp/sp ace/q.mjs", "file:///tmp/sp%20ace/q.mjs")).toBe(true);
    expect(isDirectInvocation("/r/o.mjs", "file:///r/q.mjs")).toBe(false);
    expect(isDirectInvocation(undefined, "file:///r/q.mjs")).toBe(false);
  });

  it("backs off exponentially, capped, or at a fixed poll", () => {
    expect(backoffMs(0)).toBe(250);
    expect(backoffMs(2)).toBe(1000);
    expect(backoffMs(40)).toBe(2000);
    expect(backoffMs(3, { CONDUCTOR_QUEUE_POLL_MS: "50" })).toBe(50);
    expect(backoffMs(0, { CONDUCTOR_QUEUE_POLL_MS: "0" })).toBe(250);
  });

  it("sleeps without a busy-wait", () => {
    const before = Date.now();
    sleepSync(30);
    expect(Date.now() - before).toBeGreaterThanOrEqual(25);
  });

  it("runs a command directly", () => {
    expect(runDirect(["x", "y"], {}, (cmd, args) => ({ status: cmd === "x" && args[0] === "y" ? 7 : 0 }))).toBe(7);
  });
});

describe("bypass", () => {
  it("bypasses on CI, on any held queue, and without flock", () => {
    expect(bypassReason({ env: {} })).toBeNull();
    expect(bypassReason({ env: { CI: "1" }, hasFlock: false })).toBe("CI");
    expect(bypassReason({ env: { [HELD_ENV]: "q:1" } })).toBe("already holding q:1");
    expect(bypassReason({ env: { [HELD_ENV]: "other:1" } })).toBe("already holding other:1");
    expect(bypassReason({ env: {}, hasFlock: false })).toMatch(/not available/);
    expect(bypassReason({ env: {} })).toBeNull();
  });

  it("always says why", () => {
    expect(bypassNotice("CI")).toMatch(/inactive \(CI\).*unguarded/);
    expect(bypassNotice("CI", "[v]")).toMatch(/^\[v\]/);
  });
});

describe("parseRunArgs", () => {
  it("reads flags before --, defaults the rest", () => {
    expect(parseRunArgs(["--queue=e2e", "--slots=2", "--priority=gate", "--timeout=1.5", "--", "a", "--queue=x"])).toEqual({
      queue: "e2e", slots: "2", priority: "gate", timeoutMs: 90_000, command: ["a", "--queue=x"],
    });
    expect(parseRunArgs(["--", "a"])).toEqual({ queue: "default", slots: undefined, priority: "normal", timeoutMs: Infinity, command: ["a"] });
    expect(parseRunArgs(["--timeout=0", "--", "a"]).timeoutMs).toBe(Infinity);
  });

  it("rejects bad input", () => {
    expect(parseRunArgs(["--bogus=1", "--", "a"]).error).toMatch(/unknown option/);
    expect(parseRunArgs(["a"]).error).toMatch(/unknown option/);
    expect(parseRunArgs(["--queue=../x", "--", "a"]).error).toMatch(/invalid queue/);
    expect(parseRunArgs(["--priority=high", "--", "a"]).error).toMatch(/priority/);
    expect(parseRunArgs(["--"]).error).toMatch(/no command/);
  });
});

describe("exec mode", () => {
  const child = (outcome) => {
    const c = new EventEmitter();
    c.kill = (sig) => { c.killed = sig; };
    queueMicrotask(() => outcome(c));
    return c;
  };
  const exits = (status, signal = null) => (c) => c.emit("exit", status, signal);

  it("records the holder, drops the ticket, announces, runs, then clears its record", async () => {
    const holder = path.join(tmp, "h.json");
    const ticket = path.join(tmp, "t.json");
    writeFileSync(ticket, "{}");
    let seen;
    let marked = false;
    const code = await execUnderLock(
      [`--holder=${holder}`, `--ticket=${ticket}`, "--priority=gate", "--slots=3", "--", "cmd", "a"],
      {
        writeMarker: () => { marked = true; },
        spawn: (c, a) => { seen = [c, a, readJson(holder), existsSync(ticket)]; return child(exits(4)); },
        signals: new EventEmitter(),
      },
    );
    expect(code).toBe(4);
    expect(marked).toBe(true);
    expect(seen[0]).toBe("cmd");
    expect(seen[2]).toMatchObject({ pid: process.pid, command: "cmd a", priority: "gate", slots: 3 });
    expect(seen[3]).toBe(false);
    expect(existsSync(holder)).toBe(false);
  });

  it("runs even with no fd 3 or records, and refuses a missing command", async () => {
    const boom = () => { throw new Error("EBADF"); };
    const deps = { writeMarker: boom, spawn: () => child(exits(0)), signals: new EventEmitter() };
    expect(await execUnderLock(["--", "x"], deps)).toBe(0);
    expect(await execUnderLock([], {})).toBe(2);
    expect(await execUnderLock(["--bad=1", "--", "x"], {})).toBe(2);
  });

  it("leaves a holder record that now belongs to someone else", async () => {
    const holder = path.join(tmp, "h.json");
    await execUnderLock([`--holder=${holder}`, "--", "x"], {
      writeMarker: () => {},
      spawn: () => { writeFileSync(holder, JSON.stringify({ pid: 1 })); return child(exits(0)); },
      signals: new EventEmitter(),
    });
    expect(existsSync(holder)).toBe(true);
  });

  it("spells a signalled or unspawnable command like a shell", async () => {
    const deps = (outcome) => ({ writeMarker: () => {}, spawn: () => child(outcome), signals: new EventEmitter() });
    expect(await execUnderLock(["--", "x"], deps(exits(null, "SIGKILL")))).toBe(137);
    expect(await execUnderLock(["--", "x"], deps((c) => c.emit("error", new Error("ENOENT"))))).toBe(1);
  });

  it("forwards SIGTERM, SIGINT and SIGHUP to the command, then stops listening", async () => {
    const signals = new EventEmitter();
    let kid;
    const done = execUnderLock(["--", "x"], {
      writeMarker: () => {},
      signals,
      spawn: () => (kid = child(() => {})),
    });
    await Promise.resolve();
    signals.emit("SIGTERM");
    expect(kid.killed).toBe("SIGTERM");
    signals.emit("SIGHUP");
    expect(kid.killed).toBe("SIGHUP");
    kid.emit("exit", 0, null);
    expect(await done).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("hands the command the lock fd at its own number, when the fd is found", async () => {
    let opts;
    const deps = (lockFd) => ({
      writeMarker: () => {},
      lockFd: () => lockFd,
      signals: new EventEmitter(),
      spawn: (c, a, o) => { opts = o; return child(exits(0)); },
    });
    await execUnderLock(["--lock=/l", "--", "x"], deps(4));
    expect(opts.stdio).toEqual(["inherit", "inherit", "inherit", "ignore", 4]);
    await execUnderLock(["--lock=/l", "--", "x"], deps(null));
    expect(opts.stdio).toBe("inherit");
    expect(childStdio(3)).toEqual(["inherit", "inherit", "inherit", 3]);
  });

  it("finds the lock fd by what /proc says it points at, and is null when it cannot", () => {
    const links = { 0: "/dev/null", 3: "pipe:[1]", 4: "/q/slot-0", 5: "/q/slot-1" };
    const link = (fd) => { if (!(fd in links)) throw new Error("ENOENT"); return links[fd]; };
    const list = () => ["0", "3", "4", "5", "6"];
    expect(findLockFd("/q/slot-1", { list, link, real: (x) => x })).toBe(5);
    expect(findLockFd("/q/none", { list, link, real: (x) => x })).toBeNull();
    expect(findLockFd("/q/slot-0", { list: () => { throw new Error("no /proc"); }, link })).toBeNull();
    expect(findLockFd(path.join(tmp, "absent"))).toBeNull();
  });
});

describe("run: fail-open and bypass paths", () => {
  const ok = ["node", "-e", "process.exit(3)"];
  const base = () => ({ queue: "q", command: ok, env: { ...process.env, CI: "", CONDUCTOR_QUEUE_DIR: tmp, CONDUCTOR_QUEUE_HELD: "" } });

  it("passes CI through silently", () => {
    const log = [];
    expect(run({ ...base(), env: { ...base().env, CI: "1" }, log: (m) => log.push(m) })).toBe(3);
    expect(log).toEqual([]);
  });

  it("passes a nested run on the same queue through, with a notice", () => {
    const log = [];
    expect(run({ ...base(), env: { ...base().env, [HELD_ENV]: "q:0" }, log: (m) => log.push(m) })).toBe(3);
    expect(log[0]).toMatch(/already holding q:0/);
  });

  it("runs unguarded with a notice where flock is missing", () => {
    const log = [];
    expect(run({ ...base(), hasFlock: false, log: (m) => log.push(m) })).toBe(3);
    expect(log[0]).toMatch(/flock/);
  });

  it("runs unguarded with a notice where the state dir is not a usable dir", () => {
    const file = path.join(tmp, "afile");
    writeFileSync(file, "x");
    const log = [];
    expect(run({ ...base(), env: { ...base().env, CONDUCTOR_QUEUE_DIR: file }, log: (m) => log.push(m) })).toBe(3);
    expect(log[0]).toMatch(/not writable/);
  });

  it("exits 76 without running when every slot is vetoed past the timeout", () => {
    const marker = path.join(tmp, "ran");
    const log = [];
    const code = run({
      ...base(),
      command: ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`],
      env: { ...base().env, CONDUCTOR_QUEUE_POLL_MS: "20" },
      canTake: () => false,
      timeoutMs: 100,
      log: (m) => log.push(m),
    });
    expect(code).toBe(TIMEOUT_EXIT);
    expect(TIMEOUT_EXIT).toBe(76);
    expect(existsSync(marker)).toBe(false);
    expect(log.join("")).toMatch(/waiting for.*\n[\s\S]*queue full/);
    expect(readdirSync(path.join(queueDir(base().env, "q"), "tickets"))).toEqual([]);
  });

  it("runs unguarded with a notice when the queue dir itself is unwritable", () => {
    const dir = queueDir(base().env, "q");
    const log = [];
    const ensure = (d) => d !== dir;
    expect(run({ ...base(), hasFlock: true, ensure, log: (m) => log.push(m) })).toBe(3);
    expect(log[0]).toMatch(/not writable/);
  });

  describe("with an injected flock", () => {
    const fake = (onAttempt) => {
      const calls = [];
      const spawn = (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd !== "flock") return { status: 3 };
        if (args[1] === "-E") return onAttempt(args);
        return { status: 1 };
      };
      return { spawn, calls, attempts: () => calls.filter(([c, a]) => c === "flock" && a[1] === "-E") };
    };
    const fast = () => ({ ...base(), hasFlock: true, env: { ...base().env, CONDUCTOR_QUEUE_POLL_MS: "10" } });

    it("runs unguarded with a notice when flock fails to spawn", () => {
      const f = fake(() => ({ error: Object.assign(new Error("x"), { code: "EACCES" }) }));
      const log = [];
      expect(run({ ...fast(), spawn: f.spawn, log: (m) => log.push(m) })).toBe(3);
      expect(log[0]).toMatch(/flock failed to spawn \(EACCES\)/);
      expect(f.calls.at(-1)[0]).toBe("node");
    });

    it("returns the exit code of an attempt that was not a conflict", () => {
      const f = fake(() => ({ status: 9, output: [null, null, null, Buffer.from("1")] }));
      expect(run({ ...fast(), spawn: f.spawn })).toBe(9);
    });

    it("keeps waiting after a conflict, and says so", () => {
      const f = fake(() => ({ status: CONFLICT_EXIT, output: [] }));
      const log = [];
      expect(run({ ...fast(), spawn: f.spawn, timeoutMs: 60, log: (m) => log.push(m) })).toBe(TIMEOUT_EXIT);
      expect(f.attempts().length).toBeGreaterThan(1);
      expect(log.join("")).toMatch(/you are #1 in line/);
    });

    it("does not attempt a slot when a fresh waiter ahead will take the free one", () => {
      const dir = queueDir(base().env, "q");
      mkdirSync(path.join(dir, "tickets"), { recursive: true });
      const ahead = alive({ pid: process.ppid, startTime: processStartTime(process.ppid), priority: "gate", createdAt: 1, slots: 1 });
      writeFileSync(path.join(dir, "tickets", `gate-1-${process.ppid}.json`), JSON.stringify(ahead));
      const f = fake(() => ({ status: 0, output: [null, null, null, Buffer.from("1")] }));
      const spawn = (cmd, args, o) => (cmd === "flock" && args[1] !== "-E" ? { status: 0 } : f.spawn(cmd, args, o));
      expect(run({ ...fast(), slots: 1, spawn, timeoutMs: 60, log: () => {} })).toBe(TIMEOUT_EXIT);
      expect(f.attempts()).toEqual([]);
    });

    // Memory recovering between polls must open slot-1 to a waiter that enqueued while it was vetoed.
    it("recomputes the memory veto every poll and records the usable slots in its ticket", () => {
      let polls = 0;
      const canTake = (i) => i === 0 || polls > 2;
      const f = fake((args) => ({ status: args[3].endsWith("slot-1") ? 0 : CONFLICT_EXIT, output: args[3].endsWith("slot-1") ? [null, null, null, Buffer.from("1")] : [] }));
      const spawn = (cmd, args, o) => {
        if (cmd === "flock" && args[1] === "-E") polls += 1;
        return f.spawn(cmd, args, o);
      };
      expect(run({ ...fast(), slots: 2, spawn, canTake, timeoutMs: 5000, log: () => {} })).toBe(0);
      expect(f.attempts().some(([, a]) => a[3].endsWith("slot-1"))).toBe(true);
    });

    it("rewrites its ticket with the usable slots each poll, restoring one that vanished", () => {
      const dir = queueDir(base().env, "q");
      let seen;
      let n = 0;
      const spawn = (cmd, args) => {
        if (cmd === "flock" && args[1] === "-E") {
          n += 1;
          const file = path.join(dir, "tickets", readdirSync(path.join(dir, "tickets"))[0] ?? "none");
          if (n === 1) rmSync(file, { force: true });
          else seen = readJson(file);
          return { status: CONFLICT_EXIT, output: [] };
        }
        return { status: 3 };
      };
      run({ ...fast(), slots: 2, spawn, canTake: (i) => i === 0, timeoutMs: 80, log: () => {} });
      expect(seen).toMatchObject({ pid: process.pid, slots: 2, usable: [0], pollMs: 10 });
    });

    it("fails open when flock exits without ever announcing the command, but not when it was killed", () => {
      const log = [];
      const failed = fake(() => ({ status: 127, output: [null, null, null, Buffer.alloc(0)] }));
      expect(run({ ...fast(), spawn: failed.spawn, log: (m) => log.push(m) })).toBe(3);
      expect(log[0]).toMatch(/flock exited 127 before starting the command/);
      const killed = fake(() => ({ status: null, signal: "SIGTERM", output: [] }));
      expect(run({ ...fast(), spawn: killed.spawn, log: () => {} })).toBe(143);
    });

    it("skips a live ticket that stopped refreshing instead of waiting behind it", () => {
      const dir = queueDir(base().env, "q");
      mkdirSync(path.join(dir, "tickets"), { recursive: true });
      const file = path.join(dir, "tickets", `gate-1-${process.ppid}.json`);
      writeFileSync(file, JSON.stringify({ pid: process.ppid, startTime: processStartTime(process.ppid), priority: "gate", createdAt: 1, slots: 1 }));
      utimesSync(file, 1, 1);
      const f = fake(() => ({ status: 0, output: [null, null, null, Buffer.from("1")] }));
      const spawn = (cmd, args, o) => (cmd === "flock" && args[1] !== "-E" ? { status: 0 } : f.spawn(cmd, args, o));
      expect(run({ ...fast(), slots: 1, spawn, timeoutMs: 2000, log: () => {} })).toBe(0);
      expect(f.attempts()).toHaveLength(1);
      expect(existsSync(file)).toBe(true);
    });

    it("probes the lock with flock -n and reads status 0 as free", () => {
      const dir = queueDir(base().env, "q");
      mkdirSync(path.join(dir, "tickets"), { recursive: true });
      writeFileSync(path.join(dir, "tickets", `gate-1-${process.ppid}.json`), JSON.stringify({ pid: process.ppid, startTime: processStartTime(process.ppid), priority: "gate", createdAt: 1, slots: 1 }));
      const probes = [];
      const spawn = (cmd, args) => {
        if (cmd === "flock" && args[1] !== "-E") { probes.push(args); return { status: 0 }; }
        return { status: 9, output: [null, null, null, Buffer.from("1")] };
      };
      expect(run({ ...fast(), slots: 2, spawn })).toBe(9);
      expect(probes[0].slice(0, 1)).toEqual(["-n"]);
      expect(probes[0].at(-1)).toBe("true");
    });
  });

  it("runs the command under a real slot and cleans up its records", () => {
    const log = [];
    expect(run({ ...base(), slots: 1, log: (m) => log.push(m) })).toBe(3);
    const dir = queueDir(base().env, "q");
    expect(readdirSync(path.join(dir, "tickets"))).toEqual([]);
    expect(listHolders(dir)).toEqual([]);
  });
});

describe("main", () => {
  const env = () => ({ ...process.env, CI: "", CONDUCTOR_QUEUE_HELD: "", CONDUCTOR_QUEUE_DIR: tmp });

  it("prints status as text and JSON, exit 0", () => {
    const out = [];
    expect(main(["status"], env(), () => {}, (m) => out.push(m))).toBe(0);
    expect(out[0]).toBe("no queues yet\n");
    expect(main(["status", "--json"], env(), () => {}, (m) => out.push(m))).toBe(0);
    expect(JSON.parse(out[1])).toEqual({ protocol: 1, queues: [] });
  });

  it("prints usage on bad input", () => {
    const log = [];
    expect(main([], env(), (m) => log.push(m))).toBe(2);
    expect(main(["run", "--", ], env(), (m) => log.push(m))).toBe(2);
    expect(log.join("")).toMatch(/usage: queue.mjs run/);
  });

  it("routes exec mode and run", async () => {
    expect(await main(["--exec"], env(), () => {})).toBe(2);
    expect(main(["run", "--queue=m", "--", "node", "-e", "process.exit(5)"], env(), () => {})).toBe(5);
  });
});

// Real processes. A private CONDUCTOR_QUEUE_DIR keeps these off the live box queue.
describe("real multi-process queue", () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, what) => {
    for (let i = 0; i < 400; i += 1) {
      if (fn()) return;
      await sleep(25);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const env = () => ({ ...process.env, CI: "", CONDUCTOR_QUEUE_HELD: "", CONDUCTOR_QUEUE_DIR: tmp, CONDUCTOR_QUEUE_POLL_MS: "100" });
  const qdir = () => path.join(tmp, "v1", "q");
  const start = (args) => {
    const child = spawn(process.execPath, [QUEUE_MJS, "run", "--queue=q", "--slots=1", ...args], { env: env(), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const done = new Promise((r) => child.on("exit", (code) => r({ code, stderr })));
    return { child, done };
  };
  const tickets = () => (existsSync(path.join(qdir(), "tickets")) ? readdirSync(path.join(qdir(), "tickets")).length : 0);

  it("admits waiters gate first, then first come first served", { timeout: 30_000 }, async () => {
    const out = path.join(tmp, "order");
    const mark = (name) => ["--", process.execPath, "-e", `require("fs").appendFileSync(${JSON.stringify(out)}, "${name}\\n")`];
    const holder = start(["--", process.execPath, "-e", "setTimeout(() => {}, 1500)"]);
    await until(() => listHolders(qdir()).length === 1, "holder");

    const waiters = [];
    for (const [name, prio] of [["A", "normal"], ["B", "normal"], ["C", "gate"]]) {
      const before = tickets();
      waiters.push(start([`--priority=${prio}`, ...mark(name)]));
      await until(() => tickets() > before, `ticket ${name}`);
      await sleep(5);
    }

    const status = spawnSync(process.execPath, [QUEUE_MJS, "status", "--json"], { env: env(), encoding: "utf8" });
    expect(status.status).toBe(0);
    const q = JSON.parse(status.stdout).queues.find((x) => x.name === "q");
    expect(q.holders).toHaveLength(1);
    expect(q.waiters.map((w) => w.priority)).toEqual(["gate", "normal", "normal"]);

    const results = await Promise.all([holder.done, ...waiters.map((w) => w.done)]);
    expect(results.map((r) => r.code)).toEqual([0, 0, 0, 0]);
    expect(readFileSync(out, "utf8")).toBe("C\nA\nB\n");
    expect(tickets()).toBe(0);
    expect(listHolders(qdir())).toEqual([]);
  });

  it("lets a 2-slot waiter take slot-1 at once while a 1-slot waiter ahead of it is blocked on slot-0", { timeout: 30_000 }, async () => {
    const out = path.join(tmp, "order");
    const mark = (name) => ["--", process.execPath, "-e", `require("fs").appendFileSync(${JSON.stringify(out)}, "${name}\\n")`];
    const holder = start(["--", process.execPath, "-e", "setTimeout(() => {}, 4000)"]);
    await until(() => listHolders(qdir()).length === 1, "holder");
    const one = start(["--slots=1", ...mark("one")]);
    await until(() => tickets() === 1, "1-slot ticket");
    await sleep(5);
    const two = start(["--slots=2", ...mark("two")]);
    const twoResult = await two.done;
    expect(twoResult.code).toBe(0);
    expect(holder.child.exitCode).toBeNull();
    expect(readFileSync(out, "utf8")).toBe("two\n");
    expect(listHolders(qdir())).toHaveLength(1);
    one.child.kill("SIGKILL");
    await Promise.all([one.done, holder.done]);
  });

  it("keeps the slot held by the command itself when the holder process is SIGKILLed", { timeout: 30_000 }, async () => {
    const orphanDone = path.join(tmp, "orphan-done");
    const seen = path.join(tmp, "seen");
    const running = path.join(tmp, "running");
    const orphan = start(["--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(running)}, "x"); setTimeout(() => require("fs").writeFileSync(${JSON.stringify(orphanDone)}, "x"), 1500)`]);
    await until(() => existsSync(running) && listHolders(qdir()).length === 1, "command running");
    process.kill(listHolders(qdir())[0].pid, "SIGKILL");
    await orphan.done;
    expect(queueSnapshot(qdir(), { sample: false }).holders).toEqual([{ slot: 0, orphan: true }]);
    const next = start(["--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(seen)}, String(require("fs").existsSync(${JSON.stringify(orphanDone)})))`]);
    expect((await next.done).code).toBe(0);
    expect(readFileSync(seen, "utf8")).toBe("true");
  });

  it("gives up within a poll of --timeout, not a whole backoff late", { timeout: 30_000 }, async () => {
    const holder = start(["--", process.execPath, "-e", "setTimeout(() => {}, 4000)"]);
    await until(() => listHolders(qdir()).length === 1, "holder");
    const t0 = Date.now();
    const waiter = start(["--timeout=0.025", "--", process.execPath, "-e", "0"]);
    const result = await waiter.done;
    expect(result.code).toBe(TIMEOUT_EXIT);
    expect(Date.now() - t0).toBeLessThan(1500 + 1000);
    await holder.done;
  });

  it("exits 76 with a queue-full line and never runs the command past --timeout", { timeout: 30_000 }, async () => {
    const marker = path.join(tmp, "ran");
    const holder = start(["--", process.execPath, "-e", "setTimeout(() => {}, 1500)"]);
    await until(() => listHolders(qdir()).length === 1, "holder");
    const waiter = start(["--timeout=0.01", "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`]);
    const result = await waiter.done;
    expect(result.code).toBe(TIMEOUT_EXIT);
    expect(result.stderr).toMatch(/queue full/);
    expect(existsSync(marker)).toBe(false);
    await holder.done;
  });
});
