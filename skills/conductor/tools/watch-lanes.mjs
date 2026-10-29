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
 * Prints one JSON line, { events }, and exits 0. Events: { event: "stalled", lane, state, quietMinutes },
 * { event: "gone", lane }, { event: "watch-error", message }, { event: "timeout" }.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const TAIL_BYTES = 256 * 1024;

/** Where the lane's last turn stands: owes-reply, tool-running, turn-ended or unknown. */
export function turnState(text) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!entry?.message) continue;
    if (entry.type === "user") return "owes-reply";
    if (entry.type !== "assistant") continue;
    const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
    if (blocks.some((b) => b?.type === "tool_use")) return "tool-running";
    return blocks.length && blocks.every((b) => b?.type === "thinking") ? "owes-reply" : "turn-ended";
  }
  return "unknown";
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
export function lastEntryState(path, start = TAIL_BYTES) {
  const size = statSync(path).size;
  for (let length = Math.min(start, size); ; length = Math.min(length * 4, size)) {
    const state = turnState(readTail(path, size, length));
    if (state !== "unknown" || length === size) return state;
  }
}

const MID_TURN = new Set(["owes-reply", "tool-running"]);

/**
 * A look at every lane, counting quiet time from the first look that saw the file as it is now.
 * A gap of more than three intervals between looks means the machine slept, so every count starts again.
 */
export function lookAtLanes(paths, { quietMinutes, intervalMs, now = Date.now }) {
  const seen = new Map();
  let lastLook = null;
  return () => {
    const t = now();
    const woke = lastLook !== null && t - lastLook > 3 * intervalMs;
    lastLook = t;
    const found = [];
    for (const path of paths) {
      const lane = basename(path).replace(/\.(output|jsonl)$/, "");
      let stat;
      try {
        stat = statSync(path);
      } catch {
        found.push({ event: "gone", lane });
        continue;
      }
      const before = seen.get(path);
      if (woke || before?.mtimeMs !== stat.mtimeMs) {
        seen.set(path, { mtimeMs: stat.mtimeMs, since: t });
        continue;
      }
      const quiet = Math.floor((t - before.since) / 60_000);
      if (quiet < quietMinutes) continue;
      const state = lastEntryState(path);
      if (MID_TURN.has(state)) found.push({ event: "stalled", lane, state, quietMinutes: quiet });
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
  const maxLooks = Math.ceil((flag("hours", 12) * 3600) / interval);
  const look = lookAtLanes(paths, { quietMinutes: flag("quiet", 15), intervalMs: interval * 1000 });
  const result = await watchLanes({ look, sleep: () => delay(interval * 1000), maxLooks });
  process.stdout.write(JSON.stringify(result) + "\n");
}
/* c8 ignore stop */
