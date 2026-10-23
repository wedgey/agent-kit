// agent-kit's copy is canonical. A repo may vendor it and must keep the protocol version and state layout.
/**
 * Denies a foreground heavy command while its queue is full, so the turn is not parked
 * behind other holders. Everything unknown or broken allows.
 */

import path from "node:path";

import { formatAge, queueDir, queueSnapshot } from "../queue.mjs";
import { commandSegments } from "./shell.mjs";

/**
 * The queue's snapshot without CPU sampling, with the caller's slot count: the next run
 * resolves slots from its own environment, not from records of earlier runs.
 */
export function readQueueStatus(env, name, slots, deps = {}) {
  return { ...queueSnapshot(queueDir(env, name), { ...deps, sample: false }), slots };
}

/** Full when someone waits, or no free slot index is one `admits` lets this run take. */
function isFull(s, admits) {
  const held = new Set(s.holders.map((h) => h.slot));
  const free = Array.from({ length: s.slots }, (_, i) => i).filter((i) => !held.has(i));
  return s.waiters.length > 0 || !free.some(admits);
}

function holderList(holders, now) {
  if (holders.length === 0) return "waiters ahead of you";
  return holders
    .map((h) => (h.acquiredAt == null ? "an orphaned run" : `${path.basename(h.cwd ?? "") || "?"} (${formatAge(now - h.acquiredAt)})`))
    .join(", ");
}

/**
 * `classify(segment)` names the queue a segment runs in, or null. `queueStatus(name)`
 * returns that queue's status, or null when unknown. `admits(slotIndex)` says whether
 * the wrapper would let a run take that free slot (memory floors). Returns the deny reason or null.
 */
export function fullQueueReason(
  command,
  runInBackground,
  queueStatus,
  classify,
  { now = Date.now(), admits = () => true } = {},
) {
  if (runInBackground === true) return null;
  for (const segment of commandSegments(command)) {
    const name = classify(segment);
    if (!name) continue;
    const status = queueStatus(name);
    if (!status || !isFull(status, admits)) continue;
    return (
      `The "${name}" queue is full (held by ${holderList(status.holders, now)}; ` +
      `${status.waiters.length} waiting). Rerun the same command with run_in_background: true ` +
      `and wait for its completion notice instead of blocking the turn.`
    );
  }
  return null;
}
