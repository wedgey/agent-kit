import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { expect } from "./expect.mjs";

import { contextNote, contextTokens, delegateTranscript, fileMemory, lastTwoContexts, sessionTranscript } from "../../skills/conductor/tools/hooks/context-guard.mjs";

const turn = (id, cacheRead, extra = {}) =>
  JSON.stringify({
    type: "assistant",
    message: { id, usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: 50, ...extra } },
  });
const boundary = () => JSON.stringify({ type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 160_000 } });
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
const memory = () => {
  const spoken = new Map();
  const key = (input) => `${input.session_id}/${input.agent_id ?? ""}`;
  return { get: (input) => spoken.get(key(input)) ?? -1, set: (input, band) => (spoken.set(key(input), band), true) };
};
const guard = (input, env, mem = memory()) => contextNote(input, env, undefined, mem);

describe("the context guard, a PostToolUse and UserPromptSubmit hook for delegates and the session's own agent", () => {
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
    expect(guard(session([turn("m1", 100_000), result(), turn("m2", 200_000)]), {})).toBeNull();
  });

  it("speaks once, on the turn that crosses the limit, and names the size and the limit", () => {
    const mem = memory();
    const out = guard(session([turn("m1", 240_000), result(), turn("m2", 251_000)]), {}, mem);
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(note(out)).toMatch(/251k tokens.*250k/);
    expect(note(out)).toMatch(/Context full/);
    expect(guard(session([turn("m1", 251_000), result(), turn("m2", 260_000)]), {}, mem)).toBeNull();
  });

  it("speaks again at each further step past the limit", () => {
    const mem = memory();
    expect(note(guard(session([turn("m1", 240_000), result(), turn("m2", 251_000)]), {}, mem))).toMatch(/251k/);
    expect(note(guard(session([turn("m1", 299_000), result(), turn("m2", 301_000)]), {}, mem))).toMatch(/301k/);
    expect(guard(session([turn("m1", 301_000), result(), turn("m2", 340_000)]), {}, mem)).toBeNull();
  });

  it("speaks on a later call when the call that crossed the limit got no hook, such as a failed one", () => {
    const mem = memory();
    expect(note(guard(ownSession([turn("m1", 152_000), result(), turn("m2", 153_000)]), {}, mem))).toMatch(/153k/);
    expect(guard(ownSession([turn("m1", 153_000), result(), turn("m2", 154_000)]), {}, mem)).toBeNull();
  });

  it("speaks again when the context drops below the limit and grows back, as after a compaction", () => {
    const mem = memory();
    expect(note(guard(ownSession([turn("m1", 149_000), result(), turn("m2", 151_000)]), {}, mem))).toMatch(/151k/);
    expect(guard(ownSession([turn("m1", 151_000), result(), turn("m2", 40_000)]), {}, mem)).toBeNull();
    expect(note(guard(ownSession([turn("m1", 40_000), result(), turn("m2", 160_000)]), {}, mem))).toMatch(/160k/);
  });

  it("keeps what it said per session and agent in a state folder, and reads an empty or bad file as unknown", () => {
    const dir = mkdtempSync(join(tmpdir(), "context-guard-state-"));
    const s = session([turn("m1", 251_000)]);
    expect(fileMemory(dir).get(s)).toBe(-1);
    expect(fileMemory(dir).set(s, 0)).toBe(true);
    expect(fileMemory(dir).get(s)).toBe(0);
    expect(fileMemory(dir).get({ ...s, agent_id: "a2" })).toBe(-1);
    for (const bad of ["", "x"]) {
      writeFileSync(join(dir, readdirSync(dir)[0]), bad);
      expect(fileMemory(dir).get(s)).toBeUndefined();
    }
  });

  it("falls back to speaking once per crossing when its state cannot be kept", () => {
    const blocked = join(mkdtempSync(join(tmpdir(), "context-guard-state-")), "file");
    writeFileSync(blocked, "");
    const mem = fileMemory(join(blocked, "under-a-file"));
    const s = ownSession([turn("m1", 149_000), result(), turn("m2", 151_000)]);
    expect(note(contextNote(s, {}, undefined, mem))).toMatch(/151k/);
    expect(contextNote(ownSession([turn("m1", 151_000), result(), turn("m2", 152_000)]), {}, undefined, mem)).toBeNull();
  });

  it("takes the limit from CONDUCTOR_CONTEXT_LIMIT, and ignores a blank or bad value", () => {
    const s = session([turn("m1", 140_000), result(), turn("m2", 160_000)]);
    expect(note(guard(s, { CONDUCTOR_CONTEXT_LIMIT: "150000" }))).toMatch(/150k/);
    expect(guard(s, { CONDUCTOR_CONTEXT_LIMIT: "" })).toBeNull();
    expect(guard(s, { CONDUCTOR_CONTEXT_LIMIT: "lots" })).toBeNull();
  });

  it("reads the session's own transcript when no agent_id comes in", () => {
    expect(sessionTranscript({ transcript_path: "/p/s1.jsonl", session_id: "s1" })).toBe("/p/s1.jsonl");
    expect(sessionTranscript({ transcript_path: "/p/s1.jsonl", session_id: "s1", agent_id: "a1" })).toBeNull();
  });

  it("tells the session's own agent at its lower limit to hand an epic over", () => {
    const mem = memory();
    const out = note(guard(ownSession([turn("m1", 149_000), result(), turn("m2", 151_000)]), {}, mem));
    expect(out).toMatch(/151k tokens.*150k/);
    expect(out).toMatch(/Hand over/);
    expect(guard(ownSession([turn("m1", 151_000), result(), turn("m2", 160_000)]), {}, mem)).toBeNull();
    expect(note(guard(ownSession([turn("m1", 199_000), result(), turn("m2", 201_000)]), {}, mem))).toMatch(/201k/);
  });

  it("takes the session's limit from CONDUCTOR_SESSION_CONTEXT_LIMIT, apart from the delegates' limit", () => {
    const s = ownSession([turn("m1", 90_000), result(), turn("m2", 110_000)]);
    expect(note(guard(s, { CONDUCTOR_SESSION_CONTEXT_LIMIT: "100000" }))).toMatch(/100k/);
    expect(guard(s, { CONDUCTOR_CONTEXT_LIMIT: "100000" })).toBeNull();
    expect(note(guard(ownSession([turn("m1", 140_000), result(), turn("m2", 160_000)]), { CONDUCTOR_SESSION_CONTEXT_LIMIT: "" }))).toMatch(/150k/);
  });

  it("tells a lane run as a separate session to report Context full, not to hand the epic over", () => {
    expect(note(guard(ownSession([turn("m1", 149_000), result(), turn("m2", 151_000)]), {}))).toMatch(/If you are a lane.*Context full report.*Otherwise, if you steer an epic/);
  });

  it("tells any other session to hand over in place when its stage ends, not to suggest a fresh session", () => {
    const out = note(guard(ownSession([turn("m1", 149_000), result(), turn("m2", 151_000)]), {}));
    expect(out).toMatch(/Otherwise, when the stage in hand ends, hand over in place: call mcp__conductor__handover.*waiting on the operator, wait for the answer first.*Without that tool, tell the operator/);
  });

  it("reminds the session on every operator prompt while it is still past its limit", () => {
    const mem = memory();
    const lines = [turn("m1", 149_000), result(), turn("m2", 151_000)];
    expect(note(guard(ownSession(lines), {}, mem))).toMatch(/151k/);
    const prompt = { ...ownSession(lines), hook_event_name: "UserPromptSubmit" };
    const first = guard(prompt, {}, mem);
    expect(first.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(note(first)).toMatch(/151k tokens.*when the work this prompt asks for ends, call mcp__conductor__handover.*unless you end by asking the operator/);
    expect(note(guard(prompt, {}, mem))).toMatch(/151k/);
    expect(guard({ ...ownSession([turn("m1", 100_000)]), hook_event_name: "UserPromptSubmit" }, {}, mem)).toBeNull();
    expect(guard({ ...prompt, agent_id: "a1" }, {}, mem)).toBeNull();
  });

  it("reads no turn from before a compaction, so the resume prompt after a handover gets no stale note", () => {
    const compacted = { ...ownSession([turn("m1", 155_000), result(), turn("m2", 160_000), boundary()]), hook_event_name: "UserPromptSubmit" };
    expect(guard(compacted, {})).toBeNull();
    expect(lastTwoContexts([turn("m1", 155_000), boundary(), turn("m2", 40_000)].join("\n"))).toEqual([40_010, 0]);
  });

  it("tells a session past its limit again when it crosses the limit after a handover's compaction", () => {
    const mem = memory();
    const before = [turn("m1", 149_000), result(), turn("m2", 151_000)];
    expect(note(guard(ownSession(before), {}, mem))).toMatch(/151k/);
    expect(guard(ownSession([...before, boundary(), turn("m3", 40_000)]), {}, mem)).toBeNull();
    expect(note(guard(ownSession([...before, boundary(), turn("m3", 40_000), result(), turn("m4", 152_000)]), {}, mem))).toMatch(/152k/);
  });

  it("honours every bypass", () => {
    const s = session([turn("m1", 240_000), result(), turn("m2", 251_000)]);
    expect(guard(ownSession([turn("m1", 149_000), result(), turn("m2", 151_000)]), { CONDUCTOR_HOOKS: "off" })).toBeNull();
    expect(guard(s, { CONDUCTOR_HOOKS: "off" })).toBeNull();
    expect(guard(s, { CI: "1" })).toBeNull();
    expect(guard({ ...s, agent_id: "missing" }, {})).toBeNull();
    expect(guard(null, {})).toBeNull();
  });

  it("prints the note from stdin and nothing for garbage, exit 0", () => {
    const file = fileURLToPath(new URL("../../skills/conductor/tools/hooks/context-guard.mjs", import.meta.url));
    const run = (input) => spawnSync("node", [file], { input, env: { ...process.env, CI: "", CONDUCTOR_HOOKS: "", CONDUCTOR_CONTEXT_LIMIT: "", CONDUCTOR_SESSION_CONTEXT_LIMIT: "" }, encoding: "utf8" });
    const out = run(JSON.stringify({ ...ownSession([turn("m1", 140_000), result(), turn("m2", 151_000)]), session_id: randomUUID() }));
    expect(JSON.parse(out.stdout).hookSpecificOutput.additionalContext).toMatch(/Context full/);
    expect(run("nope")).toMatchObject({ status: 0, stdout: "" });
  });
});
