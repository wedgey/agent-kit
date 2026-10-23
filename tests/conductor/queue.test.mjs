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
  DUPLICATE_EXIT,
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
  stopSlot,
  lockHolders,
  orphanProcess,
  statusJson,
  memoryAdmits,
  meminfo as meminfoOf,
  treeCpuPct,
  treeMemKb,
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

describe("memory admission and the status shape", () => {
  const meminfo = (text) => () => text;
  it("reads MemTotal and MemAvailable, null where absent or unreadable", () => {
    expect(meminfoOf({}, meminfo("MemTotal: 100 kB\nMemAvailable:   40 kB\n"))).toEqual({ memTotalKb: 100, memAvailKb: 40 });
    expect(meminfoOf({}, () => { throw new Error("no proc"); })).toEqual({ memTotalKb: null, memAvailKb: null });
    expect(meminfoOf({ CONDUCTOR_QUEUE_PROC: "/fake" }, (f) => (f === "/fake/meminfo" ? "MemAvailable: 1 kB" : ""))).toEqual({ memTotalKb: null, memAvailKb: 1 });
  });

  it("admits past slot 0 only above the floor, 4096 MB by default, and when memory is unknown", () => {
    const avail = (kb) => meminfo(`MemAvailable: ${kb} kB`);
    expect(memoryAdmits({}, avail(4096 * 1024))).toBe(true);
    expect(memoryAdmits({}, avail(4096 * 1024 - 1))).toBe(false);
    expect(memoryAdmits({ CONDUCTOR_QUEUE_MIN_FREE_MB: "1" }, avail(1024))).toBe(true);
    expect(memoryAdmits({ CONDUCTOR_QUEUE_MIN_FREE_MB: "junk" }, avail(1024))).toBe(false);
    expect(memoryAdmits({}, () => { throw new Error("x"); })).toBe(true);
  });

  it("projects an orphan with nulls and fills what a record lacks", () => {
    const queues = [{ name: "q", slots: 2, slotsSource: "files", holders: [{ slot: 0, orphan: true }, { slot: 1, pid: 5 }], waiters: [] }];
    const json = statusJson(queues, {}, { readFile: () => "", cores: 4, load1: 1.5 });
    expect(json.queues[0].holders).toEqual([
      { slot: 0, pid: null, cwd: null, command: null, ageMs: null, state: "orphan", cpuPct: null, memKb: null },
      { slot: 1, pid: 5, cwd: null, command: null, ageMs: null, state: "unknown", cpuPct: null, memKb: null },
    ]);
    expect(json.machine).toEqual({ cores: 4, load1: 1.5, memAvailKb: null, memTotalKb: null });
  });

  it("counts CPU only for processes in both samples, and sums resident memory over the tree", () => {
    const a = new Map([[1, { ppid: 0, ticks: 100 }], [2, { ppid: 1, ticks: 50 }]]);
    const b = new Map([[1, { ppid: 0, ticks: 150 }], [2, { ppid: 1, ticks: 100 }], [3, { ppid: 2, ticks: 900 }]]);
    expect(treeCpuPct(a, b, 1, 1000)).toBe(100);
    expect(treeCpuPct(a, b, 9, 1000)).toBeNull();
    expect(treeMemKb(b, 1, (pid) => (pid === 3 ? "" : `Name: x\nVmRSS:\t  ${pid * 10} kB\n`))).toBe(30);
    expect(treeMemKb(b, 1, () => { throw new Error("gone"); })).toBeNull();
  });
});

describe("orphaned slots", () => {
  const stat = (start) => `1 (x) S ${Array.from({ length: 50 }, (_, i) => (i === 18 ? String(start) : "0")).join(" ")}`;
  it("finds every process with the lock open by its fd links, and nothing for an unreadable file", () => {
    const deps = { pids: () => ["1", "2", "3"], fds: (pid) => (pid === 3 ? ["5"] : pid === 2 ? (() => { throw new Error("EACCES"); })() : ["4", "9"]), link: (pid, fd) => (fd === "9" || pid === 3 ? "/q/slot-0" : "/dev/null"), real: (f) => f };
    expect(lockHolders("/q/slot-0", deps)).toEqual([1, 3]);
    expect(lockHolders("/q/slot-0", { ...deps, real: () => { throw new Error("ENOENT"); } })).toEqual([]);
  });

  it("names the earliest-started holder with its cwd, command line and age, and nothing when none is found", () => {
    const files = { "/proc/7/stat": stat(500), "/proc/8/stat": stat(100), "/proc/8/cmdline": "bash\0-c\0sleep 9\0", "/proc/uptime": "11.00 3.0" };
    const readFile = (f) => {
      if (f in files) return files[f];
      throw new Error("ENOENT");
    };
    expect(orphanProcess("/q/slot-0", { lockHolders: () => [7, 8], readFile, readlink: () => "/w/lane" })).toEqual({
      pid: 8, startTime: 100, cwd: "/w/lane", command: "bash -c sleep 9", ageMs: 10_000,
    });
    expect(orphanProcess("/q/slot-0", { lockHolders: () => [] })).toEqual({});
    expect(holderLine({ slot: 2, orphan: true, pid: 8, ageMs: 10_000, cwd: "/w", command: "x" })).toBe("slot 2: orphaned run (no record), pid 8, 10s, /w, x");
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
  const base = () => ({ queue: "q", command: ok, env: { ...process.env, CI: "", CONDUCTOR_QUEUE_DIR: tmp, CONDUCTOR_QUEUE_HELD: "", CONDUCTOR_QUEUE_MIN_FREE_MB: "0" } });

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
      expect(run({ ...fast(), spawn: f.spawn, timeoutMs: 500, log: (m) => log.push(m) })).toBe(TIMEOUT_EXIT);
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
      run({ ...fast(), slots: 2, spawn, canTake: (i) => i === 0, timeoutMs: 500, log: () => {} });
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
    expect(JSON.parse(out[1])).toMatchObject({ protocol: 1, queues: [] });
    expect(Object.keys(JSON.parse(out[1]).machine).sort()).toEqual(["cores", "load1", "memAvailKb", "memTotalKb"]);
  });

  it("prints stop and move results as JSON, exit 1 when there is nothing to act on", () => {
    const out = [];
    expect(main(["stop", "q", "0"], env(), () => {}, (m) => out.push(m))).toBe(1);
    expect(JSON.parse(out[0])).toMatchObject({ ok: false });
    expect(main(["move", "normal-1-1", "top"], env(), () => {}, (m) => out.push(m))).toBe(1);
    expect(main(["move", "../x", "top"], env(), () => {}, (m) => out.push(m))).toBe(1);
    expect(main(["move", "normal-1-1", "sideways"], env(), () => {}, (m) => out.push(m))).toBe(1);
    expect(main(["stop", "q"], env(), (m) => out.push(m))).toBe(2);
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
  const env = (over = {}) => ({ ...process.env, CI: "", CONDUCTOR_QUEUE_HELD: "", CONDUCTOR_QUEUE_DIR: tmp, CONDUCTOR_QUEUE_POLL_MS: "100", CONDUCTOR_QUEUE_MIN_FREE_MB: "0", ...over });
  const qdir = () => path.join(tmp, "v1", "q");
  const start = (args, over = {}) => {
    const child = spawn(process.execPath, [QUEUE_MJS, "run", "--queue=q", "--slots=1", ...args], { env: env(over), stdio: ["ignore", "ignore", "pipe"] });
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
  });

  const mark = (out, name) => ["--", process.execPath, "-e", `require("fs").appendFileSync(${JSON.stringify(out)}, "${name}\\n")`];
  const statusOf = (over = {}) => JSON.parse(spawnSync(process.execPath, [QUEUE_MJS, "status", "--json"], { env: env(over), encoding: "utf8" }).stdout);
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [QUEUE_MJS, ...args], { env: env(), encoding: "utf8" });
    return { code: r.status, json: JSON.parse(r.stdout || "null") };
  };

  it("refuses a second run of the same command from the same directory, running or waiting, with exit 75", { timeout: 30_000 }, async () => {
    const hold = ["--", process.execPath, "-e", "setTimeout(() => {}, 3000)"];
    const holder = start(["--slots=2", ...hold]);
    await until(() => listHolders(qdir()).length === 1, "holder");
    const twin = await start(["--slots=2", ...hold]).done;
    expect(twin.code).toBe(DUPLICATE_EXIT);
    expect(twin.stderr).toMatch(/not starting it twice: ".*setTimeout.*" is already running in slot 0 of the q queue \(\d+s\), from /);
    expect(holder.child.exitCode).toBeNull();

    const out = path.join(tmp, "order");
    const waiter = start(mark(out, "W"));
    await until(() => tickets() === 1, "waiter");
    const second = await start(mark(out, "W")).done;
    expect(second.code).toBe(DUPLICATE_EXIT);
    expect(second.stderr).toMatch(/already waiting at #1 in the q queue/);
    expect((await waiter.done).code).toBe(0);
    await holder.done;
    expect(readFileSync(out, "utf8")).toBe("W\n");
  });

  it("starts a second run beside the first only with enough free memory, and slot 0 always", { timeout: 30_000 }, async () => {
    const proc = path.join(tmp, "proc");
    mkdirSync(proc);
    const meminfo = (kb) => writeFileSync(path.join(proc, "meminfo"), `MemTotal: 16000000 kB\nMemAvailable: ${kb} kB\n`);
    meminfo(1000);
    const low = { CONDUCTOR_QUEUE_PROC: proc, CONDUCTOR_QUEUE_MIN_FREE_MB: "4096" };
    const holder = start(["--slots=2", "--", process.execPath, "-e", "setTimeout(() => {}, 4000)"], low);
    await until(() => listHolders(qdir()).length === 1, "holder on slot 0 despite low memory");
    const vetoed = await start(["--slots=2", "--timeout=0.02", "--", process.execPath, "-e", "0"], low).done;
    expect(vetoed.code).toBe(TIMEOUT_EXIT);
    meminfo(8_000_000);
    const admitted = await start(["--slots=2", "--timeout=0.05", "--", process.execPath, "-e", "1"], low).done;
    expect(admitted.code).toBe(0);
    expect(holder.child.exitCode).toBeNull();
    holder.child.kill("SIGKILL");
    await holder.done;
  });

  it("reports status JSON in the pane's shape, with each holder's CPU and memory", { timeout: 30_000 }, async () => {
    const holder = start(["--", process.execPath, "-e", "const t = Date.now() + 3000; while (Date.now() < t);"]);
    await until(() => listHolders(qdir()).length === 1, "holder");
    const waiter = start(["--priority=gate", "--", process.execPath, "-e", "0"]);
    await until(() => tickets() === 1, "waiter");
    const s = statusOf({ CONDUCTOR_QUEUE_SLOTS_Q: "1" });
    expect(Object.keys(s).sort()).toEqual(["machine", "protocol", "queues"]);
    const [q] = s.queues;
    expect(Object.keys(q)).toEqual(["name", "slots", "slotsSource", "holders", "waiters"]);
    expect([q.name, q.slots, q.slotsSource]).toEqual(["q", 1, "env"]);
    expect(statusOf().queues[0].slotsSource).toBe("records");
    const [h] = q.holders;
    expect(Object.keys(h)).toEqual(["slot", "pid", "cwd", "command", "ageMs", "state", "cpuPct", "memKb"]);
    expect(h).toMatchObject({ slot: 0, cwd: process.cwd(), state: "busy" });
    expect(h.cpuPct).toBeGreaterThan(30);
    expect(h.memKb).toBeGreaterThan(1000);
    expect(h.command).toMatch(/Date\.now/);
    const [w] = q.waiters;
    expect(Object.keys(w)).toEqual(["ticket", "pid", "cwd", "command", "priority", "rank", "waitedMs"]);
    expect(w).toMatchObject({ pid: waiter.child.pid, priority: "gate", rank: 0 });
    expect(w.ticket).toMatch(new RegExp(`^gate-\\d+-${waiter.child.pid}$`));
    const m = s.machine;
    expect(m.cores).toBeGreaterThan(0);
    expect(typeof m.load1).toBe("number");
    expect(m.memTotalKb).toBeGreaterThan(m.memAvailKb);
    await Promise.all([holder.done, waiter.done]);
  });

  it("stop terminates the holder's whole process tree and frees the slot", { timeout: 30_000 }, async () => {
    const pids = path.join(tmp, "pids");
    const tree = `sleep 30 & echo $! >> ${pids}; sleep 30 & echo $! >> ${pids}; echo $$ >> ${pids}; wait`;
    const holder = start(["--", "bash", "-c", tree]);
    await until(() => existsSync(pids) && readFileSync(pids, "utf8").trim().split("\n").length === 3 && listHolders(qdir()).length === 1, "tree");
    const { code, json } = cli("stop", "q", "0");
    expect(code).toBe(0);
    expect(json).toMatchObject({ ok: true, killed: 0 });
    expect(json.stopped).toBeGreaterThanOrEqual(4);
    expect((await holder.done).code).toBeGreaterThan(0);
    // A killed child reparented to a pid 1 that never reaps stays a zombie: gone all the same.
    const gone = (pid) => { try { return readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z "); } catch { return true; } };
    for (const pid of readFileSync(pids, "utf8").trim().split("\n").map(Number)) expect(gone(pid)).toBe(true);
    expect(listHolders(qdir())).toEqual([]);
  });

  it("stop sends SIGKILL to what ignores SIGTERM past the grace period", { timeout: 30_000 }, async () => {
    const ready = path.join(tmp, "ready");
    const holder = start(["--", process.execPath, "-e", `process.on("SIGTERM", () => {}); require("fs").writeFileSync(${JSON.stringify(ready)}, "x"); setInterval(() => {}, 1000)`]);
    await until(() => existsSync(ready) && listHolders(qdir()).length === 1, "stubborn holder");
    const result = stopSlot(env(), "q", 0, { graceMs: 300 });
    expect(result.ok).toBe(true);
    expect(result.killed).toBeGreaterThanOrEqual(1);
    await holder.done;
    expect(stopSlot(env(), "q", 0)).toMatchObject({ ok: false });
    expect(stopSlot(env(), "../q", 0)).toMatchObject({ ok: false });
  });

  it("move reorders real waiters within their priority, and the waiters keep the new order", { timeout: 30_000 }, async () => {
    const out = path.join(tmp, "order");
    const release = path.join(tmp, "release");
    const holder = start(["--", process.execPath, "-e", `const t = setInterval(() => require("fs").existsSync(${JSON.stringify(release)}) && clearInterval(t), 20)`]);
    await until(() => listHolders(qdir()).length === 1, "holder");
    const waiters = {};
    for (const name of ["A", "B", "C"]) {
      waiters[name] = start(mark(out, name));
      await until(() => tickets() === Object.keys(waiters).length, `ticket ${name}`);
      await sleep(5);
    }
    const line = () => freshTickets(listTickets(qdir()), Date.now());
    const id = (name) => line().find((w) => w.pid === waiters[name].child.pid).ticket;
    const order = () => line().map((w) => Object.keys(waiters).find((n) => waiters[n].child.pid === w.pid));
    expect(order()).toEqual(["A", "B", "C"]);
    expect(cli("move", id("C"), "top")).toEqual({ code: 0, json: { ok: true } });
    expect(order()).toEqual(["C", "A", "B"]);
    expect(cli("move", id("A"), "down").json).toEqual({ ok: true });
    expect(cli("move", id("B"), "up").json).toEqual({ ok: true });
    await sleep(400);
    expect(order()).toEqual(["B", "C", "A"]);
    const [w] = statusOf().queues[0].waiters;
    expect(w.ticket).toBe(id("B"));
    expect(w.waitedMs).toBeGreaterThan(300);
    writeFileSync(release, "x");
    await Promise.all([holder.done, ...Object.values(waiters).map((x) => x.done)]);
    expect(readFileSync(out, "utf8")).toBe("B\nC\nA\n");
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
    const [orphaned] = queueSnapshot(qdir(), { sample: false }).holders;
    expect(orphaned).toMatchObject({ slot: 0, orphan: true, cwd: process.cwd() });
    expect(orphaned.command).toMatch(/orphan-done/);
    expect(orphaned.ageMs).toBeGreaterThanOrEqual(0);
    expect(orphaned.ageMs).toBeLessThan(30_000);
    expect(processStartTime(orphaned.pid)).toBe(orphaned.startTime);
    const next = start(["--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(seen)}, String(require("fs").existsSync(${JSON.stringify(orphanDone)})))`]);
    expect((await next.done).code).toBe(0);
    expect(readFileSync(seen, "utf8")).toBe("true");
  });

  it("finds an orphaned slot's process by its lock fd, reports it in status, and stop frees the slot", { timeout: 30_000 }, async () => {
    const running = path.join(tmp, "running");
    const done = path.join(tmp, "done");
    const orphan = start(["--", "bash", "-c", `touch ${running}; sleep 20; touch ${done}`]);
    await until(() => existsSync(running) && listHolders(qdir()).length === 1, "command running");
    process.kill(listHolders(qdir())[0].pid, "SIGKILL");
    await orphan.done;
    const [h] = statusOf().queues[0].holders;
    expect(h).toMatchObject({ slot: 0, state: "orphan", cwd: process.cwd() });
    expect(h.command).toMatch(/^bash -c touch .*sleep 20/);
    expect(typeof h.pid).toBe("number");
    expect(h.memKb).toBeGreaterThan(0);
    const { code, json } = cli("stop", "q", "0");
    expect(code).toBe(0);
    expect(json).toMatchObject({ ok: true, killed: 0 });
    expect(json.stopped).toBeGreaterThanOrEqual(2);
    const t0 = Date.now();
    expect((await start(["--", process.execPath, "-e", "0"]).done).code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(existsSync(done)).toBe(false);
  });

  it("move says when priority blocks it or the waiter is already there, and moves nothing then", { timeout: 30_000 }, async () => {
    const release = path.join(tmp, "release");
    const holder = start(["--", process.execPath, "-e", `const t = setInterval(() => require("fs").existsSync(${JSON.stringify(release)}) && clearInterval(t), 20)`]);
    await until(() => listHolders(qdir()).length === 1, "holder");
    const gate = start(["--priority=gate", "--", process.execPath, "-e", "1"]);
    await until(() => tickets() === 1, "gate ticket");
    const normal = start(["--", process.execPath, "-e", "2"]);
    await until(() => tickets() === 2, "normal ticket");
    const line = () => freshTickets(listTickets(qdir()), Date.now());
    const id = (w) => line().find((t) => t.pid === w.child.pid).ticket;
    const before = line().map((t) => [t.ticket, t.createdAt]);
    expect(cli("move", id(normal), "top")).toEqual({ code: 1, json: { ok: false, reason: "a normal run can't pass a gate run" } });
    expect(cli("move", id(normal), "up").json).toEqual({ ok: false, reason: "a normal run can't pass a gate run" });
    expect(cli("move", id(gate), "down").json).toEqual({ ok: false, reason: "a gate run can't drop behind a normal run" });
    expect(cli("move", id(gate), "top")).toEqual({ code: 0, json: { ok: true, note: "already at the top" } });
    expect(cli("move", id(normal), "down").json).toEqual({ ok: true, note: "already at the bottom" });
    expect(line().map((t) => [t.ticket, t.createdAt])).toEqual(before);
    writeFileSync(release, "x");
    await Promise.all([holder.done, gate.done, normal.done]);
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
