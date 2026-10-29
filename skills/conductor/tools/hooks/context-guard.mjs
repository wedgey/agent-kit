#!/usr/bin/env node
// agent-kit's copy is canonical. A repo may vendor it and must keep the protocol version and state layout.
/**
 * A PostToolUse command hook that tells a delegate, or the session's own agent, when its context passes conductor's limit.
 * Every turn re-reads the whole context, so a long lane's late turns cost the most: across 25 lanes
 * measured on 2026-10-24, the second half of each lane's turns used 65% of its tokens.
 * The session's own agent steers an epic for days, so it gets a lower limit of its own.
 * It speaks once when the limit is crossed, then once per further step.
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BYPASS_ENV } from "./classify.mjs";
import { bypassed } from "./hook-io.mjs";

export const DEFAULT_LIMIT = 250_000;
export const DEFAULT_SESSION_LIMIT = 150_000;
export const STEP = 50_000;
const TAIL_BYTES = 1 << 20;

/** Every input token a turn sent: fresh, cache write and cache read. Output is not context yet. */
export function contextTokens(usage) {
  return (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);
}

/** Claude Code keeps a delegate's transcript at <session dir>/<session id>/subagents/agent-<agent id>.jsonl. */
export function delegateTranscript(input) {
  if (!input?.agent_id || !input.transcript_path || !input.session_id) return null;
  return join(dirname(input.transcript_path), input.session_id, "subagents", `agent-${input.agent_id}.jsonl`);
}

/** The context of the last two turns, newest first. One turn can span several lines with one message id. */
export function lastTwoContexts(text) {
  const found = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && found.length < 2; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const message = entry?.type === "assistant" ? entry.message : null;
    if (!message?.usage || found.some((f) => f.id === message.id)) continue;
    found.push({ id: message.id, tokens: contextTokens(message.usage) });
  }
  return [found[0]?.tokens ?? 0, found[1]?.tokens ?? 0];
}

/** The session's own agent reads its context from the session transcript. A delegate never does. */
export function sessionTranscript(input) {
  if (input?.agent_id || !input?.transcript_path) return null;
  return input.transcript_path;
}

function readTail(path) {
  const size = statSync(path).size;
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
}

function limitFrom(raw, fallback) {
  const value = Number(raw?.trim() || fallback);
  return Number.isFinite(value) && value > 0 ? value : null;
}

const band = (tokens, limit) => (tokens < limit ? -1 : Math.floor((tokens - limit) / STEP));
const k = (tokens) => `${Math.round(tokens / 1000)}k`;

const DELEGATE_ACTION =
  `Finish the edit in hand and run its check. Start no new stage. ` +
  `If you are a lane, push your branch and end your turn with a Context full report, per roles.md "Lanes". ` +
  `Otherwise end your turn with your report, and put what remains under OPEN.`;
// A lane run as its own session has no agent_id either, so the session note must route it to its report.
const SESSION_ACTION =
  `If you are a lane, push your branch and send a Context full report to REPORT TO, per roles.md "Lanes". ` +
  `Otherwise, if you steer an epic, finish the notice in hand, then hand over per epic.md "Hand over the epic". ` +
  `Otherwise, when the stage in hand ends, tell the operator in one line that a fresh session would be cheaper.`;

export function contextNote(input, env, read = readTail) {
  const own = sessionTranscript(input);
  const path = own ?? delegateTranscript(input);
  const limit = own ? limitFrom(env.CONDUCTOR_SESSION_CONTEXT_LIMIT, DEFAULT_SESSION_LIMIT) : limitFrom(env.CONDUCTOR_CONTEXT_LIMIT, DEFAULT_LIMIT);
  if (!path || !limit || bypassed("", env, BYPASS_ENV)) return null;
  let now, before;
  try {
    [now, before] = lastTwoContexts(read(path));
  } catch {
    return null;
  }
  if (band(now, limit) <= band(before, limit)) return null;
  const note =
    `Conductor: your context is ${k(now)} tokens, past the limit of ${k(limit)}. Every turn re-reads all of it. ` +
    (own ? SESSION_ACTION : DELEGATE_ACTION);
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note } };
}

/* c8 ignore start -- process wiring */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let out = null;
  try {
    out = contextNote(JSON.parse(readFileSync(0, "utf8")), process.env);
  } catch {}
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
/* c8 ignore stop */
