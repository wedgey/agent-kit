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
 * Defaults: 15 quiet minutes, three times that for a lane inside a tool call, twice that for a lane that ended its turn
 * on something other than a report, a look every 60 seconds, 72 hours.
 *
 * Prints one JSON line, { events }, and exits 0. Events: { event: "stalled", lane, state, quietMinutes, box },
 * { event: "parked", lane, quietMinutes, box } for a lane that ended its turn without a report and never woke,
 * { event: "finished", lane, log, exit, quietMinutes, box } for a parked lane once every named log written after it parked
 * ends on `EXIT <n>` and has been still for FINISHED_MINUTES (log and exit are the first that failed, else the last named),
 * { event: "box-slow", lanes, box } when two or more stall or park in one look (finished lanes are never grouped), { event: "gone", lane }, { event: "watch-error", message }, { event: "timeout" }.
 */

import { closeSync, openSync, readSync, statSync, existsSync, realpathSync } from "node:fs";
import { availableParallelism, freemem, loadavg } from "node:os";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const TAIL_BYTES = 256 * 1024;

// A delegate that reports through a handback tool ends its turn on that tool's result. Seen on v2.1.308 to 309.
const HANDBACK_TOOLS = new Set(["SubagentHandback"]);

const blocksOf = (entry) => (Array.isArray(entry.message.content) ? entry.message.content : [{ type: "text", text: String(entry.message.content ?? "") }]);

// A lane's reports, from roles.md "Lanes". A turn that ends on one is a message to the orchestrator, so the lane is idle by design.
const REPORT = /^\W*(merge-ready|merged|head moved|blocked|failed|context full)\b/i;

/** Where the lane's last turn stands: owes-reply, tool-running, parked, turn-ended or unknown. */
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
  if (blocks.length && blocks.every((b) => b?.type === "thinking")) return "owes-reply";
  const said = blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  return REPORT.test(said) ? "turn-ended" : "parked";
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

// An absolute path in the lane's last message, which roles.md "Lanes" has it write when it parks.
const LOG_PATH = /(?<![\w.~$/-])\/[\w.@+-]+(?:\/[\w.@+-]+)*\.(?:log|output|txt)(?![\w.]*\w)/g;
const EXIT_LINE = /(?:^|\n)EXIT (-?\d+)\s*$/;
// The log must be still this long, so output that a child of the job writes after EXIT holds the nudge.
const FINISHED_MINUTES = 2;

/** The log paths the lane's last assistant message names. */
export function namedLogs(text) {
  const lines = text.split("\n").reverse();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== "assistant" || !entry.message) continue;
      const said = blocksOf(entry).filter((b) => b?.type === "text").map((b) => b.text).join("\n");
      return [...new Set(said.match(LOG_PATH) ?? [])];
    } catch {}
  }
  return [];
}

/** The lane's turn state, widening the read until an entry with a message fits. Single entries reach megabytes. */
export function lastEntryState(path, start = TAIL_BYTES, size = statSync(path).size) {
  for (let length = Math.min(start, size); ; length = Math.min(length * 4, size)) {
    const state = turnState(readTail(path, size, length));
    if (state !== "unknown" || length === size) return state;
  }
}

// A healthy foreground call or a wait behind the queue outlasts one quiet limit.
// Lowering these factors reports live lanes as stalled.
const QUIET_FACTOR = { "owes-reply": 1, "tool-running": 3, parked: 2 };

/**
 * A look at every lane, counting quiet time from the first look that saw the file as it is now.
 * A gap of more than three intervals between looks means the machine slept, so every count starts again.
 */
const machine = () => ({ load1: Math.round(loadavg()[0] * 10) / 10, cores: availableParallelism(), freeMB: Math.round(freemem() / 1048576) });

export function lookAtLanes(paths, { quietMinutes, intervalMs, now = Date.now, box = machine }) {
  const seen = new Map();
  const logs = new Map();
  // undefined: missing or not written since the lane parked. null: still running. A number: its exit code.
  const finished = (log, parkedMs, t, woke) => {
    let stat;
    try {
      stat = statSync(log);
    } catch {
      return undefined;
    }
    const before = logs.get(log);
    if (woke || before?.mtimeMs !== stat.mtimeMs || before?.size !== stat.size) {
      logs.set(log, { mtimeMs: stat.mtimeMs, size: stat.size, since: t });
      return null;
    }
    const exit = readTail(log, stat.size, Math.min(stat.size, 4096)).match(EXIT_LINE);
    // A log that ended before the lane parked is an old run; one still open is a job that may be silent mid-run.
    if (stat.mtimeMs <= parkedMs) return exit ? undefined : null;
    if (t - before.since < FINISHED_MINUTES * 60_000) return null;
    return exit ? Number(exit[1]) : null;
  };
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
        const names = namedLogs(readTail(path, stat.size, Math.min(stat.size, TAIL_BYTES)));
        seen.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, since: t, logs: names });
        for (const log of names) finished(log, stat.mtimeMs, t, true);
        continue;
      }
      const quiet = Math.floor((t - before.since) / 60_000);
      if (quiet < Math.min(quietMinutes, FINISHED_MINUTES)) continue;
      before.state ??= lastEntryState(path, TAIL_BYTES, stat.size);
      if (before.state === "parked") {
        const written = before.logs.map((log) => ({ log, exit: finished(log, stat.mtimeMs, t, false) })).filter((d) => d.exit !== undefined);
        if (written.length && written.every((d) => d.exit !== null)) {
          found.push({ event: "finished", lane, ...(written.find((d) => d.exit !== 0) ?? written.at(-1)), quietMinutes: quiet });
          continue;
        }
      }
      if (quiet < quietMinutes) continue;
      const factor = QUIET_FACTOR[before.state];
      if (!factor || quiet < quietMinutes * factor) continue;
      found.push(before.state === "parked" ? { event: "parked", lane, quietMinutes: quiet } : { event: "stalled", lane, state: before.state, quietMinutes: quiet });
    }
    const stalled = found.filter((f) => f.event === "stalled" || f.event === "parked");
    const done = found.filter((f) => f.event === "finished");
    if (!stalled.length && !done.length) return found;
    const load = box();
    const rest = [...found.filter((f) => !stalled.includes(f) && !done.includes(f)), ...done.map((f) => ({ ...f, box: load }))];
    // Lanes going quiet together point at the box, and replacing them would only add load to it.
    if (stalled.length > 1) return [...rest, { event: "box-slow", lanes: stalled.map((f) => f.lane), box: load }];
    return stalled.length ? [...rest, { ...stalled[0], box: load }] : rest;
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
const entry = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : "";
if (entry === realpathSync(fileURLToPath(import.meta.url))) {
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
