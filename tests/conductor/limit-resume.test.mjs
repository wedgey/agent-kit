import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { expect } from "./expect.mjs";

import { limitStop, parseResetAt } from "../../skills/conductor/tools/hooks/limit-resume-hook.mjs";
import { resumedSince, waitForReset } from "../../skills/conductor/tools/limit-resume.mjs";

const written = {};
const writes = {
  write: (file, text) => { written[file] = text; },
  remove: (file) => { delete written[file]; },
  mkdir: () => {},
};
const entry = (type, text) => JSON.stringify({ type, message: { content: Array.isArray(text) ? text : [{ type: "text", text }] } });

describe("the reset time in the limit message", () => {
  const now = Date.parse("2026-11-22T00:10:00Z");
  it("reads an am and a pm time, as the next such moment", () => {
    expect(parseResetAt("You've hit your 5-hour limit · resets 10:40am (UTC)", now)).toBe(Date.parse("2026-11-22T10:40:00Z"));
    expect(parseResetAt("You've hit your 5-hour limit · resets 3:40pm (UTC)", now)).toBe(Date.parse("2026-11-22T15:40:00Z"));
    expect(parseResetAt("You've hit your 5-hour limit · resets 11:59pm (UTC)", now)).toBe(Date.parse("2026-11-22T23:59:00Z"));
  });

  it("answers null, arming nothing, for a message it cannot read or a zone it cannot convert", () => {
    expect(parseResetAt("Merge-ready: PR #1 open", now)).toBeNull();
    expect(parseResetAt("You've hit your 5-hour limit · resets Monday", now)).toBeNull();
    expect(parseResetAt("You've hit your weekly limit · resets 10:40am (KST)", now)).toBeNull();
  });
});

describe("the limit stop hook", () => {
  const run = (transcript, text) => limitStop({ session_id: "s1", transcript_path: transcript }, { read: () => Buffer.from(text), size: () => text.length, ...writes });

  it("records the cut with the offset of the limit entry, in the state folder", () => {
    const text = entry("user", "go") + "\n" + entry("assistant", "You've hit your 5-hour limit · resets 10:40am (UTC)") + "\n";
    const out = run("/t/s1.jsonl", text);
    expect(typeof out.resetAt).toBe("number");
    const state = JSON.parse(written[path.join(os.tmpdir(), "conductor-limit-resume", "s1.json")]);
    expect(state.offset).toBe(text.length);
    expect(state.transcript).toBe("/t/s1.jsonl");
  });

  it("removes the state on any later stop that is not a limit cut, because the session resumed", () => {
    written[path.join(os.tmpdir(), "conductor-limit-resume", "s1.json")] = "{}";
    expect(run("/t/s1.jsonl", entry("assistant", "Merge-ready: PR #1"))).toBeNull();
    expect(written[path.join(os.tmpdir(), "conductor-limit-resume", "s1.json")]).toBeUndefined();
  });

  it("does nothing without a session or a transcript it can read", () => {
    expect(limitStop({}, writes)).toBeNull();
    expect(run("/t/missing.jsonl", null)).toBeNull();
  });
});

describe("the reset waiter", () => {
  it("sees a session's own writing past the limit entry as a resume", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "limit-resume-"));
    const parked = path.join(dir, "parked.jsonl");
    const moved = path.join(dir, "moved.jsonl");
    writeFileSync(parked, entry("assistant", "You've hit your 5-hour limit · resets 10:40am (UTC)") + "\n");
    writeFileSync(moved, entry("assistant", "You've hit your 5-hour limit") + "\n" + entry("assistant", "carrying on") + "\n");
    mkdirSync(path.join(dir, "state"), { recursive: true });
    const state = path.join(dir, "state");
    const files = { parked: { session: "parked", transcript: parked, offset: readFileSync(parked, "utf8").length, resetAt: Date.now() - 1000 }, moved: { session: "moved", transcript: moved, offset: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "You've hit your 5-hour limit" }] } }).length + 1, resetAt: Date.now() - 1000 } };
    for (const [name, s] of Object.entries(files)) writeFileSync(path.join(state, `${name}.json`), JSON.stringify(s));
    const removed = [];
    const out = await waitForReset(state, { interval: 0, remove: (f) => removed.push(f), now: () => Date.now() });
    expect(out.pending.map((p) => p.session)).toEqual(["parked"]);
    expect(removed.length).toBe(1);

    rmSync(dir, { recursive: true });
  });

  it("exits at once with nobody when nothing is parked", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "limit-resume-"));
    const out = await waitForReset(dir, { interval: 0 });
    expect(out).toEqual({ reset: null, pending: [] });
    rmSync(dir, { recursive: true });
  });
});
