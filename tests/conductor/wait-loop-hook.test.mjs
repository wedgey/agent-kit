import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { expect } from "./expect.mjs";

import { waitLoopDecision } from "../../skills/conductor/tools/hooks/wait-loop-hook.mjs";

const bash = (command, extra = {}) => ({ tool_name: "Bash", tool_input: { command, ...extra } });
const reason = (out) => out?.hookSpecificOutput?.permissionDecisionReason;

describe("the PreToolUse wait-loop hook, which works without mods", () => {
  it("denies a foreground wait loop as a PreToolUse deny, with the bypass hint", () => {
    const out = waitLoopDecision(bash("until true; do sleep 1; done"), {});
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(reason(out)).toMatch(/^Do not block the turn by sleeping or polling\..*CONDUCTOR_HOOKS=off/);
  });

  it("passes a background loop, any other command, another tool, and every bypass", () => {
    expect(waitLoopDecision(bash("until true; do sleep 1; done", { run_in_background: true }), {})).toBeNull();
    expect(waitLoopDecision(bash("pnpm test"), {})).toBeNull();
    expect(waitLoopDecision({ tool_name: "Read", tool_input: { command: "until true; do sleep 1; done" } }, {})).toBeNull();
    expect(waitLoopDecision(bash("until true; do sleep 1; done"), { CONDUCTOR_HOOKS: "off" })).toBeNull();
    expect(waitLoopDecision(bash("until true; do sleep 1; done"), { CI: "1" })).toBeNull();
    expect(waitLoopDecision(null, {})).toBeNull();
  });

  it("prints the deny from stdin and nothing for garbage, exit 0", () => {
    const file = fileURLToPath(new URL("../../skills/conductor/tools/hooks/wait-loop-hook.mjs", import.meta.url));
    const run = (input) => spawnSync("node", [file], { input, env: { ...process.env, CI: "", CONDUCTOR_HOOKS: "" }, encoding: "utf8" });
    expect(JSON.parse(run(JSON.stringify(bash("while true; do sleep 5; done"))).stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(run("nope")).toMatchObject({ status: 0, stdout: "" });
  });
});
