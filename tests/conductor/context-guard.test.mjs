import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { expect } from "./expect.mjs";

import { contextNote, contextTokens, delegateTranscript, lastTwoContexts, sessionTranscript } from "../../skills/conductor/tools/hooks/context-guard.mjs";

const turn = (id, cacheRead, extra = {}) =>
  JSON.stringify({
    type: "assistant",
    message: { id, usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: 50, ...extra } },
  });
const result = () => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } });

/** A session's own transcript holding the given turns, with no agent_id in the hook input. */
function ownSession(lines) {
  const dir = mkdtempSync(join(tmpdir(), "context-guard-"));
  writeFileSync(join(dir, "s1.jsonl"), lines.join("\n") + "\n");
  return { session_id: "s1", transcript_path: join(dir, "s1.jsonl"), hook_event_name: "PostToolUse" };
}

/** A session folder with one delegate transcript holding the given turns. */
function session(lines) {
  const dir = mkdtempSync(join(tmpdir(), "context-guard-"));
  mkdirSync(join(dir, "s1", "subagents"), { recursive: true });
  writeFileSync(join(dir, "s1", "subagents", "agent-a1.jsonl"), lines.join("\n") + "\n");
  return { session_id: "s1", transcript_path: join(dir, "s1.jsonl"), agent_id: "a1", agent_type: "general-purpose", hook_event_name: "PostToolUse" };
}
const note = (out) => out?.hookSpecificOutput?.additionalContext;

describe("the context guard, a PostToolUse hook for delegates and the session's own agent", () => {
  it("counts every input token the turn sent, and not its output", () => {
    expect(contextTokens({ input_tokens: 5, cache_creation_input_tokens: 7, cache_read_input_tokens: 100, output_tokens: 999 })).toBe(112);
  });

  it("finds a delegate's own transcript beside the session's", () => {
    expect(delegateTranscript({ transcript_path: "/p/s1.jsonl", session_id: "s1", agent_id: "a1" })).toBe("/p/s1/subagents/agent-a1.jsonl");
    expect(delegateTranscript({ transcript_path: "/p/s1.jsonl", session_id: "s1" })).toBeNull();
  });

  it("reads the last two turns, once each, even when one turn spans several lines", () => {
    const text = [turn("m1", 100), result(), turn("m2", 200), turn("m2", 200), result(), turn("m3", 300), ""].join("\n");
    expect(lastTwoContexts(text)).toEqual([310, 210]);
    expect(lastTwoContexts(turn("m1", 100))).toEqual([110, 0]);
    expect(lastTwoContexts("garbage\n{\n")).toEqual([0, 0]);
  });

  it("says nothing below the limit", () => {
    expect(contextNote(session([turn("m1", 100_000), result(), turn("m2", 200_000)]), {})).toBeNull();
  });

  it("speaks once, on the turn that crosses the limit, and names the size and the limit", () => {
    const out = contextNote(session([turn("m1", 240_000), result(), turn("m2", 251_000)]), {});
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(note(out)).toMatch(/251k tokens.*250k/);
    expect(note(out)).toMatch(/Context full/);
    expect(contextNote(session([turn("m1", 251_000), result(), turn("m2", 260_000)]), {})).toBeNull();
  });

  it("speaks again at each further step past the limit", () => {
    expect(note(contextNote(session([turn("m1", 299_000), result(), turn("m2", 301_000)]), {}))).toMatch(/301k/);
    expect(contextNote(session([turn("m1", 301_000), result(), turn("m2", 340_000)]), {})).toBeNull();
  });

  it("takes the limit from CONDUCTOR_CONTEXT_LIMIT, and ignores a blank or bad value", () => {
    const s = session([turn("m1", 140_000), result(), turn("m2", 160_000)]);
    expect(note(contextNote(s, { CONDUCTOR_CONTEXT_LIMIT: "150000" }))).toMatch(/150k/);
    expect(contextNote(s, { CONDUCTOR_CONTEXT_LIMIT: "" })).toBeNull();
    expect(contextNote(s, { CONDUCTOR_CONTEXT_LIMIT: "lots" })).toBeNull();
  });

  it("reads the session's own transcript when no agent_id comes in", () => {
    expect(sessionTranscript({ transcript_path: "/p/s1.jsonl", session_id: "s1" })).toBe("/p/s1.jsonl");
    expect(sessionTranscript({ transcript_path: "/p/s1.jsonl", session_id: "s1", agent_id: "a1" })).toBeNull();
  });

  it("tells the session's own agent at its lower limit to hand an epic over", () => {
    const out = note(contextNote(ownSession([turn("m1", 149_000), result(), turn("m2", 151_000)]), {}));
    expect(out).toMatch(/151k tokens.*150k/);
    expect(out).toMatch(/Hand over/);
    expect(contextNote(ownSession([turn("m1", 151_000), result(), turn("m2", 160_000)]), {})).toBeNull();
    expect(note(contextNote(ownSession([turn("m1", 199_000), result(), turn("m2", 201_000)]), {}))).toMatch(/201k/);
  });

  it("takes the session's limit from CONDUCTOR_SESSION_CONTEXT_LIMIT, apart from the delegates' limit", () => {
    const s = ownSession([turn("m1", 90_000), result(), turn("m2", 110_000)]);
    expect(note(contextNote(s, { CONDUCTOR_SESSION_CONTEXT_LIMIT: "100000" }))).toMatch(/100k/);
    expect(contextNote(s, { CONDUCTOR_CONTEXT_LIMIT: "100000" })).toBeNull();
    expect(note(contextNote(ownSession([turn("m1", 140_000), result(), turn("m2", 160_000)]), { CONDUCTOR_SESSION_CONTEXT_LIMIT: "" }))).toMatch(/150k/);
  });

  it("tells a lane run as a separate session to report Context full, not to hand the epic over", () => {
    expect(note(contextNote(ownSession([turn("m1", 149_000), result(), turn("m2", 151_000)]), {}))).toMatch(/If you are a lane.*Context full report.*Otherwise, if you steer an epic/);
  });

  it("honours every bypass", () => {
    const s = session([turn("m1", 240_000), result(), turn("m2", 251_000)]);
    expect(contextNote(ownSession([turn("m1", 149_000), result(), turn("m2", 151_000)]), { CONDUCTOR_HOOKS: "off" })).toBeNull();
    expect(contextNote(s, { CONDUCTOR_HOOKS: "off" })).toBeNull();
    expect(contextNote(s, { CI: "1" })).toBeNull();
    expect(contextNote({ ...s, agent_id: "missing" }, {})).toBeNull();
    expect(contextNote(null, {})).toBeNull();
  });

  it("prints the note from stdin and nothing for garbage, exit 0", () => {
    const file = fileURLToPath(new URL("../../skills/conductor/tools/hooks/context-guard.mjs", import.meta.url));
    const run = (input) => spawnSync("node", [file], { input, env: { ...process.env, CI: "", CONDUCTOR_HOOKS: "", CONDUCTOR_CONTEXT_LIMIT: "" }, encoding: "utf8" });
    const out = run(JSON.stringify(session([turn("m1", 240_000), result(), turn("m2", 251_000)])));
    expect(JSON.parse(out.stdout).hookSpecificOutput.additionalContext).toMatch(/Context full/);
    expect(run("nope")).toMatchObject({ status: 0, stdout: "" });
  });
});
