#!/usr/bin/env node
// agent-kit's copy is canonical. A repo may vendor it.
/**
 * Watches an epic's lanes and exits when one goes quiet in the middle of a turn, so the orchestrator
 * waits in the background at no model cost and wakes on a stalled lane. A lane whose model stream
 * stalls never ends its turn, so it sends no notice, and the harness's own stall notice can arrive hours late.
 * Quiet time runs on the watch's own looks, not the file's age, so a machine waking from sleep reports nothing.
 *
 *   watch-lanes.mjs <transcript>... [--quiet=<minutes>] [--interval=<seconds>] [--hours=<n>]
 *
 * Defaults: 15 quiet minutes, three times that for a lane inside a tool call, a look every 60 seconds, 72 hours.
 *
 * Prints one JSON line, { events }, and exits 0. Events: { event: "stalled", lane, state, quietMinutes },
 * { event: "gone", lane }, { event: "watch-error", message }, { event: "timeout" }.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const TAIL_BYTES = 256 * 1024;

// A delegate that reports through a handback tool ends its turn on that tool's result. Seen on v2.1.308 to 309.
const HANDBACK_TOOLS = new Set(["SubagentHandback"]);

const blocksOf = (entry) => (Array.isArray(entry.message.content) ? entry.message.content : [{ type: "text", text: String(entry.message.content ?? "") }]);

/** Where the lane's last turn stands: owes-reply, tool-running, turn-ended or unknown. */
export function turnState(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (entry?.message && (entry.type === "user" || entry.type === "assistant")) entries.push(entry);
    } catch {}
  }
  const last = entries.at(-1);
  if (!last) return "unknown";
  const blocks = blocksOf(last);
  if (last.type === "user") {
    if (blocks.some((b) => b?.type === "text" && b.text?.startsWith("[Request interrupted"))) return "turn-ended";
    const ids = new Set(blocks.filter((b) => b?.type === "tool_result").map((b) => b.tool_use_id));
    const call = entries.flatMap(blocksOf).find((b) => b?.type === "tool_use" && ids.has(b.id));
    return call && HANDBACK_TOOLS.has(call.name) ? "turn-ended" : "owes-reply";
  }
  if (blocks.some((b) => b?.type === "tool_use")) return "tool-running";
  return blocks.length && blocks.every((b) => b?.type === "thinking") ? "owes-reply" : "turn-ended";
}

function readTail(path, size, length) {
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
}

/** The lane's turn state, widening the read until an entry with a message fits. Single entries reach megabytes. */
export function lastEntryState(path, start = TAIL_BYTES, size = statSync(path).size) {
  for (let length = Math.min(start, size); ; length = Math.min(length * 4, size)) {
    const state = turnState(readTail(path, size, length));
    if (state !== "unknown" || length === size) return state;
  }
}

// Healthy foreground calls ran 18 to 22 minutes, so a tool call gets three quiet limits before it counts.
const QUIET_FACTOR = { "owes-reply": 1, "tool-running": 3 };

/**
 * A look at every lane, counting quiet time from the first look that saw the file as it is now.
 * A gap of more than three intervals between looks means the machine slept, so every count starts again.
 */
export function lookAtLanes(paths, { quietMinutes, intervalMs, now = Date.now }) {
  const seen = new Map();
  let lastLook = null;
  let started = null;
  return () => {
    const t = now();
    const woke = lastLook !== null && t - lastLook > 3 * intervalMs;
    lastLook = t;
    started ??= t;
    const found = [];
    for (const path of paths) {
      const lane = basename(path).replace(/\.(output|jsonl)$/, "");
      let stat;
      try {
        stat = statSync(path);
      } catch {
        // A lane's transcript can appear after its watch starts, so only a file seen before, or long missing, is gone.
        if (seen.has(path) || t - started >= quietMinutes * 60_000) found.push({ event: "gone", lane });
        continue;
      }
      const before = seen.get(path);
      if (woke || before?.mtimeMs !== stat.mtimeMs || before?.size !== stat.size) {
        seen.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, since: t });
        continue;
      }
      const quiet = Math.floor((t - before.since) / 60_000);
      if (quiet < quietMinutes) continue;
      before.state ??= lastEntryState(path, TAIL_BYTES, stat.size);
      const factor = QUIET_FACTOR[before.state];
      if (factor && quiet >= quietMinutes * factor) found.push({ event: "stalled", lane, state: before.state, quietMinutes: quiet });
    }
    return found;
  };
}

/** Looks until a lane needs the orchestrator, `maxLooks` runs out, or `maxErrors` looks fail in a row. */
export async function watchLanes({ look, sleep, maxLooks, maxErrors = 5 }) {
  let errors = 0;
  for (let i = 0; i < maxLooks; i++) {
    if (i > 0) await sleep();
    let found;
    try {
      found = await look();
      errors = 0;
    } catch (error) {
      if (++errors >= maxErrors) return { events: [{ event: "watch-error", message: String(error?.message ?? error).split("\n")[0] }] };
      continue;
    }
    if (found.length) return { events: found };
  }
  return { events: [{ event: "timeout" }] };
}

/* c8 ignore start -- process wiring */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const paths = args.filter((a) => !a.startsWith("--"));
  const flag = (name, fallback) => {
    const value = Number(args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  if (!paths.length) {
    process.stderr.write("usage: watch-lanes.mjs <transcript>... [--quiet=<minutes>] [--interval=<seconds>] [--hours=<n>]\n");
    process.exit(2);
  }
  const interval = Math.max(15, flag("interval", 60));
  const maxLooks = Math.ceil((flag("hours", 72) * 3600) / interval);
  const look = lookAtLanes(paths, { quietMinutes: flag("quiet", 15), intervalMs: interval * 1000 });
  const result = await watchLanes({ look, sleep: () => delay(interval * 1000), maxLooks });
  process.stdout.write(JSON.stringify(result) + "\n");
}
/* c8 ignore stop */
