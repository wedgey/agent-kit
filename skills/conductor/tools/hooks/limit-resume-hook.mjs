#!/usr/bin/env node
// agent-kit's copy is canonical. A repo may vendor it and keep the state layout.
/**
 * A Stop hook that records a usage-limit cut, so the orchestrator's reset waiter (limit-resume.mjs)
 * and any human recovery know every stopped session and the minute it comes back. It never blocks
 * the stop and sends nothing: waking the session is the waiter's and the orchestrator's job, because
 * no channel reaches a stopped session from outside it.
 *
 * State: <temp>/conductor-limit-resume/<session_id>.json, holding the transcript path, the byte
 * offset of the limit entry (anything past it that the session itself wrote means it resumed) and
 * the parsed reset time. Any later stop without a limit message removes the file: the session
 * resumed on its own.
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LIMIT_PATTERN = /hit your (?:5-hour|weekly|daily) limit\b[^]*?resets (\d{1,2}):(\d{2})(am|pm)?(?:\s+\((UTC|[A-Za-z/]+)\))?/;

/** The next moment the printed reset time can mean, in ms since the epoch. Null when it cannot say. */
export function parseResetAt(text, now = Date.now()) {
  const m = text && LIMIT_PATTERN.exec(text);
  if (!m) return null;
  let hours = Number(m[1]) % 12;
  if (m[3] === undefined ? m[1] > 12 : false) return null; // 24-hour clock has no am/pm; reject the mix.
  if (m[3] === "pm") hours += 12;
  const at = new Date(now);
  at.setUTCHours(hours, Number(m[2]), 0, 0);
  if (m[4] !== undefined && m[4] !== "UTC") return null; // a named zone we do not convert; fail safe.
  if (at.getTime() <= now) at.setUTCDate(at.getUTCDate() + 1);
  return at.getTime();
}

const TAIL = 64 * 1024;
const lastAssistantText = (transcript, read, size) => {
  let text = "";
  const total = size(transcript);
  const fh = read(transcript, Math.max(0, total - TAIL), TAIL);
  for (const line of String(fh).split("\n")) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const blocks = entry?.message?.content;
    if (entry?.type === "assistant" && Array.isArray(blocks)) {
      const said = blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
      if (said.trim()) text = said;
    }
  }
  return text;
};

export function limitStop(input, { read = (file, start, length) => readFileSync(file).subarray(start, start + length), size = statSync, write = writeFileSync, remove = rmSync, mkdir = mkdirSync, now = Date.now } = {}) {
  const session = input?.session_id;
  const transcript = input?.transcript_path;
  if (!session || !transcript) return null;
  const dir = path.join(os.tmpdir(), "conductor-limit-resume");
  const state = path.join(dir, `${session}.json`);
  let said = "";
  try { said = lastAssistantText(transcript, read, size); } catch { return null; }
  const resetAt = parseResetAt(said, now);
  if (resetAt === null) {
    try { remove(state); } catch {} // A stop that is not a limit cut means this session resumed.
    return null;
  }
  mkdir(dir, { recursive: true });
  write(state, JSON.stringify({ session, transcript, offset: size(transcript), resetAt }));
  return { resetAt };
}

/* c8 ignore start -- process wiring */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { limitStop(JSON.parse(readFileSync(0, "utf8"))); } catch {}
  process.exit(0);
}
