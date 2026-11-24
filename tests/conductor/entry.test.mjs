import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { expect } from "./expect.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TOOLS = join(ROOT, "skills/conductor/tools");
const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const ENV = { ...process.env, CI: "", CONDUCTOR_HOOKS: "", CONDUCTOR_CONTEXT_LIMIT: "", CONDUCTOR_SESSION_CONTEXT_LIMIT: "" };

/** The tools folder reached through a symlink, as a plugin installed under a symlinked config dir is. */
function linkedTools() {
  const tmp = mkdtempSync(join(tmpdir(), "conductor-entry-"));
  made.push(tmp);
  symlinkSync(TOOLS, join(tmp, "tools"));
  return { tmp, tools: join(tmp, "tools") };
}

describe("conductor's scripts run when reached through a symlinked folder", () => {
  it("never compare the raw process.argv[1] with their own path", () => {
    const scripts = ["skills/conductor/tools", "hooks"].flatMap((dir) => readdirSync(join(ROOT, dir), { recursive: true }).filter((f) => f.endsWith(".mjs")).map((f) => join(dir, f)));
    const raw = scripts.filter((f) => /process\.argv\[1\]\s*[!=]==|[!=]==\s*process\.argv\[1\]/.test(readFileSync(join(ROOT, f), "utf8")));
    expect(raw).toEqual([]);
  });

  it("the context guard tells a session past its limit, through the link", () => {
    const { tmp, tools } = linkedTools();
    const turn = (id, tokens) => JSON.stringify({ type: "assistant", message: { id, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens } } });
    const transcript = join(tmp, "session.jsonl");
    writeFileSync(transcript, [turn("m1", 150_000), turn("m2", 160_000)].join("\n") + "\n");
    const input = JSON.stringify({ hook_event_name: "UserPromptSubmit", transcript_path: transcript, session_id: randomUUID() });
    const out = spawnSync("node", [join(tools, "hooks", "context-guard.mjs")], { input, env: ENV, encoding: "utf8" });
    expect(JSON.parse(out.stdout).hookSpecificOutput.additionalContext).toMatch(/past the limit of 150k/);
  });

  it("a script a repo may vendor, limit-resume, still runs through the link", () => {
    const { tmp, tools } = linkedTools();
    const out = spawnSync("node", [join(tools, "limit-resume.mjs"), tmp], { env: ENV, encoding: "utf8" });
    expect(JSON.parse(out.stdout)).toEqual({ reset: null, pending: [] });
  });

  it("a vendored script imported with no script path, as by node -e, neither runs nor throws", () => {
    const out = spawnSync("node", ["-e", `import(${JSON.stringify(join(TOOLS, "limit-resume.mjs"))})`], { env: ENV, encoding: "utf8" });
    expect(out).toMatchObject({ status: 0, stdout: "" });
  });

  it("the wait-loop hook denies a foreground wait loop, through the link", () => {
    const { tools } = linkedTools();
    const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "while true; do sleep 5; done" } });
    const out = spawnSync("node", [join(tools, "hooks", "wait-loop-hook.mjs")], { input, env: ENV, encoding: "utf8" });
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
