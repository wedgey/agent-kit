import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { expect } from "./expect.mjs";

const SCRIPT = fileURLToPath(new URL("../../hooks/session-start.mjs", import.meta.url));
const run = (script = SCRIPT) => spawnSync(process.execPath, [script], { input: '{"source":"startup"}', encoding: "utf8" });
const context = (result) => JSON.parse(result.stdout).hookSpecificOutput;

/** The script alone in a plugin root with no setup.md beside it. */
function strandedCopy() {
  const hooks = path.join(mkdtempSync(path.join(os.tmpdir(), "session-start-")), "hooks");
  mkdirSync(hooks);
  copyFileSync(SCRIPT, path.join(hooks, "session-start.mjs"));
  return path.join(hooks, "session-start.mjs");
}

describe("session-start hook", () => {
  it("prints setup.md's pointer as SessionStart additionalContext, in the plugin's command form", () => {
    const result = run();
    const out = context(result);
    expect([result.status, out.hookEventName]).toEqual([0, "SessionStart"]);
    expect(out.additionalContext).toContain("load the conductor skill and follow its matched playbook");
    expect(out.additionalContext).toContain("`/conductor:conductor setup` checks the install.");
    expect(out.additionalContext).not.toMatch(/<!--|```|`\/conductor[ `]/);
  });

  it("stays under the 10,000-character hook output cap", () => {
    expect(run().stdout.length).toBeLessThan(10_000);
  });

  it("falls back to its built-in pointer, identical to setup.md's, when setup.md cannot be read", () => {
    const result = run(strandedCopy());
    expect(result.status).toBe(0);
    expect(context(result)).toEqual(context(run()));
  });
});
