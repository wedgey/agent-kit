#!/usr/bin/env node
// agent-kit's copy is canonical. A repo may vendor it and keep the state layout.
/**
 * The orchestrator's reset waiter, run as a tracked background task. It sleeps until the earliest
 * usage-limit reset any stopped session declared, then prints one JSON line naming every session
 * still parked and exits, so the task's completion notice wakes the orchestrator, which resumes
 * each of them by message. A session whose transcript shows its own writing past the limit entry
 * resumed on its own; its state goes and it is not named.
 *
 *   limit-resume.mjs <stateDir> [--interval=<seconds>]
 *
 * With nothing parked it exits at once, printing nobody. The orchestrator runs one waiter at a
 * time: a new cut replaces the old waiter, whose own exit is then only noise.
 */

import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const MARGIN_MS = 2 * 60 * 1000;

/** The session's own writing past the limit entry: an assistant entry means it resumed. */
export function resumedSince(transcript, offset, read = readFileSync) {
  const text = read(transcript, "utf8");
  for (const line of text.slice(offset).split("\n")) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type === "assistant") return true;
  }
  return false;
}

export async function waitForReset(dir, { read = readFileSync, list = readdirSync, remove = rmSync, size = statSync, interval = 5, delayMs = delay, now = Date.now } = {}) {
  const state = () => list(dir).filter((f) => f.endsWith(".json")).map((f) => {
    try { return JSON.parse(read(path.join(dir, f), "utf8")); } catch { return null; }
  }).filter(Boolean);
  let parked = state();
  while (parked.length) {
    parked = parked.filter((s) => {
      try {
        if (resumedSince(s.transcript, s.offset, (file) => read(file, "utf8"))) { remove(path.join(dir, `${s.session}.json`)); return false; }
      } catch {}
      return true;
    });
    if (!parked.length) break;
    const earliest = Math.min(...parked.map((s) => s.resetAt)) + MARGIN_MS;
    const wake = now() >= earliest;
    if (wake) break;
    await delayMs(Math.min(interval * 1000, earliest - now()));
  }
  return { reset: parked.length ? new Date(Math.min(...parked.map((s) => s.resetAt))).toISOString() : null, pending: parked.map((s) => ({ session: s.session, transcript: s.transcript })) };
}

/* c8 ignore start -- process wiring */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const interval = Number(/--interval=(\d+)/.exec(process.argv.slice(2).join(" "))?.[1] ?? 30);
  if (args[0]) process.stdout.write(JSON.stringify(await waitForReset(args[0], { interval })));
}
