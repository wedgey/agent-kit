import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import { expect } from "./expect.mjs";

import { lookGateDecision } from "../../skills/conductor/tools/hooks/look-gate-hook.mjs";

const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "look-gate-test-"));
  made.push(dir);
  return dir;
};

let repo, stateDir, clock;
const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const write = (path, text) => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), text);
};
const call = (command, env = {}) => {
  clock += 10 * 60_000;
  return lookGateDecision({ tool_name: "Bash", tool_input: { command }, cwd: repo }, env, { stateDir, now: clock });
};
const E2E = "pnpm test:e2e:chromium e2e/login.spec.ts > e2e.log 2>&1";
const context = (out) => out?.hookSpecificOutput?.additionalContext;

beforeEach(() => {
  repo = temp();
  stateDir = temp();
  clock = 0;
  git("init", "-q");
  write("src/app.ts", "a");
  write("e2e/login.spec.ts", "s");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
});

describe("the look gate, which warns when an e2e spec is rerun with no look", () => {
  it("passes the first run and warns on a rerun after a code change, permissions untouched", () => {
    expect(call(E2E)).toBeNull();
    write("src/app.ts", "b");
    const out = call(E2E);
    expect(context(out)).toMatch(/no look since its last run.*agent-browser.*E2E_NO_LOOK=/);
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  it("warns on a plain rerun with nothing changed, and on the queued form", () => {
    call(E2E);
    expect(context(call(E2E))).toMatch(/no look/);
    expect(context(call(`node /p/queue.mjs run --queue=e2e -- bash -c 'cd apps/web && pnpm exec playwright test x'`))).toMatch(/no look/);
  });

  it("an untracked file counts as a change", () => {
    call(E2E);
    write("src/new.ts", "n");
    expect(context(call(E2E))).toMatch(/no look/);
  });

  it("an agent-browser call since the last run clears it, once", () => {
    call(E2E);
    write("src/app.ts", "b");
    expect(call("agent-browser --session w open http://localhost:3000")).toBeNull();
    expect(call(E2E)).toBeNull();
    write("src/app.ts", "c");
    expect(context(call(E2E))).toMatch(/no look/);
  });

  it("passes a rerun where only spec files changed, and the run after it", () => {
    call(E2E);
    write("e2e/login.spec.ts", "red first");
    expect(call(E2E)).toBeNull();
    write("src/app.ts", "the fix");
    expect(call(E2E)).toBeNull();
    write("src/app.ts", "another try");
    expect(context(call(E2E))).toMatch(/no look/);
  });

  it("passes a rerun when the last run's log shows it never reached a test", () => {
    call(E2E);
    write("e2e.log", "Refusing to start: 812 MB available, 2048 MB needed");
    write("src/app.ts", "b");
    expect(call(E2E)).toBeNull();
    write("e2e.log", "");
    expect(call(E2E)).toBeNull();
    write("e2e.log", "  ✘  1 login works\n  1 failed");
    write("src/app.ts", "c");
    expect(context(call(E2E))).toMatch(/no look/);
  });

  it("gives a retry of the same tree within two minutes the same answer, so a denied call cannot be retried past it", () => {
    call(E2E);
    clock -= 9 * 60_000;
    expect(call(E2E)).toBeNull();
    write("src/app.ts", "b");
    expect(call(E2E, { CONDUCTOR_LOOK_GATE: "deny" }).hookSpecificOutput.permissionDecision).toBe("deny");
    clock -= 9 * 60_000;
    expect(call(E2E, { CONDUCTOR_LOOK_GATE: "deny" }).hookSpecificOutput.permissionDecision).toBe("deny");
    clock -= 9 * 60_000;
    call("agent-browser snapshot");
    clock -= 9 * 60_000;
    expect(call(E2E, { CONDUCTOR_LOOK_GATE: "deny" })).toBeNull();
  });

  it("counts agent-browser only as a command run, and credits a look and a run in one command", () => {
    call(E2E);
    call("grep -r agent-browser docs");
    write("src/app.ts", "b");
    expect(context(call(E2E))).toMatch(/no look/);
    write("src/app.ts", "c");
    expect(call(`agent-browser open http://localhost:3000 && ${E2E}`)).toBeNull();
    write("src/app.ts", "d");
    expect(context(call(E2E))).toMatch(/no look/);
  });

  it("forgets a run older than twelve hours, as when a lane's worktree path is reused", () => {
    call(E2E);
    write("src/app.ts", "b");
    clock += 12 * 3_600_000;
    expect(call(E2E)).toBeNull();
  });

  it("does not count the last run's own log as a change", () => {
    call(E2E);
    write("e2e.log", "  ✘  1 login works\n  1 failed");
    write("e2e/login.spec.ts", "fixed test");
    expect(call(E2E)).toBeNull();
  });

  it("reads the stdout log, after a leading cd", () => {
    call("cd e2e && pnpm test:e2e:chromium login.spec.ts 2> err.log > out.log");
    write("e2e/err.log", "  1 failed");
    write("e2e/out.log", "Refusing to start: 812 MB available");
    write("src/app.ts", "b");
    expect(call(E2E)).toBeNull();
  });

  it("recovers from a corrupt private index", () => {
    call(E2E);
    for (const f of readdirSync(stateDir).filter((f) => f.endsWith(".index"))) writeFileSync(join(stateDir, f), "junk");
    write("src/app.ts", "b");
    expect(context(call(E2E))).toMatch(/no look/);
  });

  it("passes a command that carries E2E_NO_LOOK", () => {
    call(E2E);
    write("src/app.ts", "b");
    expect(call(`E2E_NO_LOOK="flake check" ${E2E}`)).toBeNull();
  });

  it("denies under CONDUCTOR_LOOK_GATE=deny and is silent when off or bypassed", () => {
    call(E2E);
    const out = call(E2E, { CONDUCTOR_LOOK_GATE: "deny" });
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/no look/);
    for (const env of [{ CONDUCTOR_LOOK_GATE: "off" }, { CONDUCTOR_HOOKS: "off" }, { CI: "1" }]) expect(call(E2E, env)).toBeNull();
  });

  it("ignores other commands and tools", () => {
    expect(call("pnpm test")).toBeNull();
    expect(lookGateDecision({ tool_name: "Read", tool_input: { command: E2E } }, {}, { stateDir })).toBeNull();
    expect(lookGateDecision(null, {}, { stateDir })).toBeNull();
  });

  it("prints the warning from stdin, and nothing for garbage, exit 0", () => {
    const file = fileURLToPath(new URL("../../skills/conductor/tools/hooks/look-gate-hook.mjs", import.meta.url));
    const env = { ...process.env, CI: "", CONDUCTOR_HOOKS: "", CONDUCTOR_LOOK_GATE: "", TMPDIR: stateDir };
    const run = (input) => spawnSync("node", [file], { input, env, encoding: "utf8" });
    const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: E2E }, cwd: repo });
    expect(run(input)).toMatchObject({ status: 0, stdout: "" });
    write("src/app.ts", "b");
    expect(JSON.parse(run(input).stdout).hookSpecificOutput.additionalContext).toMatch(/no look/);
    expect(run("nope")).toMatchObject({ status: 0, stdout: "" });
    expect(run(JSON.stringify({ tool_name: "Bash", tool_input: { command: E2E }, cwd: tmpdir() }))).toMatchObject({ status: 0, stdout: "" });
  });
});
