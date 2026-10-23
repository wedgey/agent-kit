import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { expect } from "./expect.mjs";

const SCRIPT = fileURLToPath(new URL("../../hooks/session-start.mjs", import.meta.url));
const run = (input) => spawnSync(process.execPath, [SCRIPT], { input, encoding: "utf8" });

describe("session-start hook", () => {
  it("prints the pointer as SessionStart additionalContext", () => {
    const result = run('{"source":"startup"}');
    const out = JSON.parse(result.stdout).hookSpecificOutput;
    expect([result.status, out.hookEventName]).toEqual([0, "SessionStart"]);
    expect(out.additionalContext).toContain("load the conductor skill and follow its matched playbook");
    expect(out.additionalContext).toContain("`/conductor:conductor setup`");
    expect(out.additionalContext).not.toMatch(/<!--|`\/conductor[ `]/);
  });

  it("stays under the 10,000-character hook output cap", () => {
    expect(run("").stdout.length).toBeLessThan(10_000);
  });
});
