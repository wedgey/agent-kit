import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { expect } from "./expect.mjs";

import { BYPASS_HINT, classifyQueued, queuedForm } from "../../skills/conductor/tools/hooks/classify.mjs";
import { decide, queuedSlots, repoManaged } from "../../skills/conductor/tools/hooks/decide.mjs";
import { parseRunArgs, processStartTime, resolveSlots } from "../../skills/conductor/tools/queue.mjs";

const QUEUE_MJS = fileURLToPath(new URL("../../skills/conductor/tools/queue.mjs", import.meta.url));
const bash = (command, extra = {}, cwd = "/w/lane") => ({ tool_name: "Bash", tool_input: { command, ...extra }, cwd });
const reason = (out) => out?.deny;
const tmp = (prefix) => mkdtempSync(path.join(os.tmpdir(), prefix));
/** A private, empty queue and plenty of memory, so no test reads the box's live queue. */
const box = (over = {}) => ({ CONDUCTOR_QUEUE_DIR: tmp("cq-"), CONDUCTOR_QUEUE_MIN_FREE_MB: "0", ...over });
const holdSlot = (env, queue, slot, rec = {}) => {
  const holders = path.join(env.CONDUCTOR_QUEUE_DIR, "v1", queue, "holders");
  mkdirSync(holders, { recursive: true });
  const record = { pid: process.pid, startTime: processStartTime(process.pid), cwd: "/w/lane-a", command: "other", acquiredAt: Date.now(), ...rec };
  writeFileSync(path.join(holders, `slot-${slot}.json`), JSON.stringify(record));
};
const fakeMeminfo = (availKb) => {
  const dir = tmp("proc-");
  writeFileSync(path.join(dir, "meminfo"), `MemTotal: 16000000 kB\nMemFree: 1 kB\nMemAvailable: ${availKb} kB\n`);
  return dir;
};

describe("the decision table", () => {
  const queued = (command, queue = "tests", segment = "pytest") => {
    const form = queuedForm(command, queue, QUEUE_MJS);
    const suggest =
      `"${segment}" is a heavy command and every repo on this box shares one queue. Run the whole command as: ${form}\n` +
      `Run it in the background and wait for the completion notice. ${BYPASS_HINT}`;
    return { command: form, suggest };
  };

  it("queues a heavy command in place when it runs in the background, even on a full queue", () => {
    const env = box();
    holdSlot(env, "tests", 0);
    expect(decide(bash("cd pkg && pytest | tail -5", { run_in_background: true }), env)).toEqual(queued("cd pkg && pytest | tail -5"));
  });

  it("queues a foreground heavy command in place when its queue has a free slot", () => {
    const out = decide(bash("pytest"), box());
    expect(out).toEqual(queued("pytest"));
    expect(out.command).toBe(`node '${QUEUE_MJS}' run --queue=tests -- bash -c 'pytest'`);
  });

  it("denies a foreground heavy command on a full queue, naming the holder and the background rerun", () => {
    const env = box();
    holdSlot(env, "e2e", 0);
    const text = reason(decide(bash("playwright test"), env));
    expect(text).toMatch(/"e2e" queue is full \(held by lane-a/);
    expect(text).toMatch(/run_in_background: true/);
  });

  it("reads a free slot past slot 0 as full while memory is under the floor, and free once it recovers", () => {
    const env = box({ CONDUCTOR_QUEUE_SLOTS_TESTS: "2", CONDUCTOR_QUEUE_MIN_FREE_MB: "4096" });
    holdSlot(env, "tests", 0);
    expect(reason(decide(bash("pytest"), { ...env, CONDUCTOR_QUEUE_PROC: fakeMeminfo(1000) }))).toMatch(/queue is full/);
    expect(decide(bash("pytest"), { ...env, CONDUCTOR_QUEUE_PROC: fakeMeminfo(8_000_000) })).toEqual(queued("pytest"));
  });

  it("denies a duplicate of a run already holding a slot, with queue.mjs's message", () => {
    const env = box();
    holdSlot(env, "tests", 0, { cwd: "/w/lane", command: "bash -c pytest", acquiredAt: Date.now() - 90_000 });
    const text = reason(decide(bash("pytest", { run_in_background: true }), env));
    expect(text).toMatch(/not starting it twice: "pytest" is already running in slot 0 of the tests queue \(1m30s\), from \/w\/lane/);
    expect(decide(bash("pytest", { run_in_background: true }, "/w/other"), env)).toEqual(queued("pytest"));
  });

  it("passes a light command and denies a foreground wait loop", () => {
    expect(decide(bash("ls"), box())).toBeNull();
    expect(reason(decide(bash("until grep -q x f; do sleep 20; done"), box()))).toMatch(/sleeping or polling/);
  });

  it("passes a heavy command in a managed repo, but still denies a wait loop there", () => {
    const env = box({ CONDUCTOR_QUEUE_MANAGED: "1" });
    expect(decide(bash("pytest", {}, undefined), env)).toBeNull();
    expect(reason(decide(bash("while true; do sleep 5; done", {}, undefined), env))).toMatch(/sleeping or polling/);
  });

  it("passes everything when bypassed from the environment, the command or CI", () => {
    expect(decide(bash("pytest"), box({ CONDUCTOR_HOOKS: "off" }))).toBeNull();
    expect(decide(bash("CONDUCTOR_HOOKS=off pytest"), box())).toBeNull();
    expect(decide(bash("until true; do sleep 1; done"), box({ CI: "1" }))).toBeNull();
  });

  it("queues the whole command when only a later segment is heavy", () => {
    expect(decide(bash("node /s/queue.mjs run -- x && pytest"), box())).toEqual(queued("node /s/queue.mjs run -- x && pytest"));
  });

  it("passes an already queued command with room, and denies it in the foreground on a full queue", () => {
    const env = box();
    const command = "node /skill/tools/queue.mjs run --queue=e2e -- bash -c 'playwright test'";
    expect(decide(bash(command), env)).toBeNull();
    holdSlot(env, "e2e", 0);
    expect(reason(decide(bash(command), env))).toMatch(/"e2e" queue is full \(held by lane-a/);
    expect(decide(bash(command, { run_in_background: true }), env)).toBeNull();
  });

  it("judges full with the slot count queue.mjs would use", () => {
    const env = box();
    holdSlot(env, "tests", 0);
    const command = "node /s/queue.mjs run --queue=tests -- bash -c 'pytest'";
    expect(reason(decide(bash(command), env))).toMatch(/"tests" queue is full/);
    expect(decide(bash(command), { ...env, CONDUCTOR_QUEUE_SLOTS_TESTS: "2" })).toBeNull();
    expect(decide(bash("node /s/queue.mjs run --queue=tests --slots=2 -- bash -c 'pytest'"), env)).toBeNull();
  });

  it("fails open on bad input, a non-Bash tool and a throwing status", () => {
    expect(decide(null, {})).toBeNull();
    expect(decide({ tool_name: "Read", tool_input: { command: "pytest" } }, {})).toBeNull();
    expect(decide(bash("node /s/queue.mjs run -- x"), box(), { queueStatus: () => { throw new Error("x"); } })).toBeNull();
    expect(decide(bash("node /s/queue.mjs run -- x"), box(), { classify: () => { throw new Error("x"); } })).toBeNull();
  });
});

describe("managed is decided for the repo the command runs in", () => {
  const repo = (settings) => {
    const top = tmp("repo-");
    mkdirSync(path.join(top, ".git"));
    mkdirSync(path.join(top, "pkg", "deep"), { recursive: true });
    if (settings !== undefined) {
      mkdirSync(path.join(top, ".claude"));
      writeFileSync(path.join(top, ".claude", "settings.json"), settings);
    }
    return top;
  };
  const managedRepo = JSON.stringify({ env: { CONDUCTOR_QUEUE_MANAGED: "1" } });

  it("a repo whose settings set the flag is managed from any folder inside it", () => {
    const top = repo(managedRepo);
    expect(repoManaged(path.join(top, "pkg", "deep"), {})).toBe(true);
    expect(decide(bash("pytest", {}, top), box())).toBeNull();
  });

  it("a repo whose settings lack the flag is not managed, whatever the session env says", () => {
    const top = repo(JSON.stringify({ env: { OTHER: "1" } }));
    expect(repoManaged(top, { CONDUCTOR_QUEUE_MANAGED: "1" })).toBe(false);
    expect(decide(bash("pytest", {}, top), box({ CONDUCTOR_QUEUE_MANAGED: "1" }))?.command).toMatch(/run --queue=tests/);
  });

  it("a repo without a settings file is not managed, whatever the session env says", () => {
    expect(repoManaged(repo(), { CONDUCTOR_QUEUE_MANAGED: "1" })).toBe(false);
  });

  it("falls back to the session env only outside any repo", () => {
    const env = { CONDUCTOR_QUEUE_MANAGED: "1" };
    expect(repoManaged(undefined, env)).toBe(true);
    expect(repoManaged(undefined, {})).toBe(false);
    expect(repoManaged(path.join(tmp("missing-"), "gone"), env)).toBe(true);
  });

  it("invalid JSON or a settings file it cannot read is not managed", () => {
    expect(repoManaged(repo("{nope"), { CONDUCTOR_QUEUE_MANAGED: "1" })).toBe(false);
    const top = repo();
    mkdirSync(path.join(top, ".claude", "settings.json"), { recursive: true });
    expect(repoManaged(top, { CONDUCTOR_QUEUE_MANAGED: "1" })).toBe(false);
  });
});

describe("slots and queue names", () => {
  it("resolves a queued segment's slots exactly as queue.mjs does", () => {
    const viaQueue = (segment, env) => {
      const argv = segment.split(/\s+/);
      const { queue, slots } = parseRunArgs(argv.slice(argv.indexOf("run") + 1));
      return resolveSlots({ flag: slots, env, queue });
    };
    const suggested = queuedForm("pytest", "tests", "/s/queue.mjs");
    for (const segment of [suggested, "node /s/queue.mjs run --queue=tests --slots=3 -- x", "node /s/queue.mjs run -- x"]) {
      for (const env of [{}, { CONDUCTOR_QUEUE_SLOTS_TESTS: "2" }, { CONDUCTOR_QUEUE_SLOTS_DEFAULT: "5" }]) {
        expect(queuedSlots(segment, env)).toBe(viaQueue(segment, env));
      }
    }
    expect(queuedSlots(suggested, {})).toBe(1);
  });

  it("names the queue of a queue.mjs run segment", () => {
    expect(classifyQueued("node /s/queue.mjs run --queue=e2e -- x")).toBe("e2e");
    expect(classifyQueued("node /s/queue.mjs run -- x")).toBe("default");
    expect(classifyQueued("node /s/queue.mjs status")).toBeNull();
    expect(classifyQueued("pytest")).toBeNull();
  });
});

describe("process wiring", () => {
  const file = fileURLToPath(new URL("../../skills/conductor/tools/hooks/decide.mjs", import.meta.url));
  const clean = { CI: "", CONDUCTOR_QUEUE_MANAGED: "", CONDUCTOR_HOOKS: "", CONDUCTOR_QUEUE_HELD: "" };
  const run = (stdin, env = {}) => spawnSync("node", [file], { input: stdin, env: { ...process.env, ...clean, ...box(), ...env }, encoding: "utf8" });
  const fakeTool = (name, script) => {
    const bin = tmp("bin-");
    writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`);
    chmodSync(path.join(bin, name), 0o755);
    return bin;
  };

  it("prints a deny for a poll loop and nothing for ls or garbage", () => {
    expect(JSON.parse(run(JSON.stringify(bash("until grep -q x f; do sleep 20; done"))).stdout).deny).toMatch(/sleeping or polling/);
    expect(run(JSON.stringify(bash("ls"))).stdout).toBe("");
    expect(run("not json").stdout).toBe("");
    expect(run("not json").status).toBe(0);
  });

  it("prints the queued form for pytest, and nothing when managed", () => {
    expect(JSON.parse(run(JSON.stringify(bash("pytest"))).stdout).command).toContain("run --queue=tests");
    expect(run(JSON.stringify(bash("pytest", {}, "")), { CONDUCTOR_QUEUE_MANAGED: "1" }).stdout).toBe("");
  });

  it("the queued form keeps a bash redirect in the foreground and its exit code", () => {
    const bin = fakeTool("pytest", "echo ran\nexit 7");
    const log = path.join(bin, "log");
    const env = { ...process.env, ...clean, ...box(), PATH: `${bin}:${process.env.PATH}` };
    const ran = spawnSync("bash", ["-c", queuedForm(`pytest &> ${log}`, "tests", QUEUE_MJS)], { env, encoding: "utf8" });
    expect(ran.status).toBe(7);
    expect(readFileSync(log, "utf8")).toBe("ran\n");
  });

  it("the printed form runs the whole command under the queue and keeps its exit code", () => {
    const env = { ...process.env, ...clean, ...box(), PATH: `${fakeTool("pytest", "exit 7")}:${process.env.PATH}` };
    const out = JSON.parse(run(JSON.stringify(bash("cd / && pytest", {}, "/")), env).stdout);
    expect(spawnSync("sh", ["-c", out.command], { env, encoding: "utf8" }).status).toBe(7);
  });

  it("denies the same command from the same directory while the first run holds its slot", { timeout: 20_000 }, async () => {
    const dir = tmp("cwd-");
    const flag = path.join(dir, "started");
    const env = { ...process.env, ...clean, ...box(), PATH: `${fakeTool("pytest", `touch ${flag}; sleep 3`)}:${process.env.PATH}` };
    const first = JSON.parse(run(JSON.stringify(bash("pytest", { run_in_background: true }, dir)), env).stdout).command;
    const child = spawn("sh", ["-c", first], { cwd: dir, env, stdio: "ignore" });
    const done = new Promise((r) => child.on("exit", r));
    for (let i = 0; i < 200 && !existsSync(flag); i += 1) await new Promise((r) => setTimeout(r, 25));
    const again = JSON.parse(run(JSON.stringify(bash("pytest", { run_in_background: true }, dir)), env).stdout);
    expect(again.deny).toMatch(/already running in slot 0 of the tests queue/);
    expect(await done).toBe(0);
    expect(readdirSync(path.join(env.CONDUCTOR_QUEUE_DIR, "v1", "tests", "holders"))).toEqual([]);
  });
});
