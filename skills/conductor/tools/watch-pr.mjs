#!/usr/bin/env node
// agent-kit's copy is canonical. A repo may vendor it.
/**
 * Watches one PR and exits on the first change its lane must act on, so the lane waits in the
 * background at no model cost and wakes on its own instead of on a message the orchestrator relays.
 *
 *   watch-pr.mjs <pr> [--repo=<owner/name>] [--interval=<seconds>] [--hours=<n>]
 *
 * Prints one JSON line, { pr, events, snapshot }, and exits 0. Events: merged, closed, conflict,
 * check-failed: <names>, checks-green, new-review, head-moved, base-merged, base-moved,
 * base-changed: <branch>, watch-error: <message>, timeout.
 */

import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const DONE_STATES = new Set(["SUCCESS", "FAILURE", "ERROR"]);

/** The parts of a PR a lane acts on. `base` is the base branch's own PR, or null when the base is trunk. */
export function snapshot(pr, base) {
  const checks = pr.statusCheckRollup ?? [];
  const failing = new Set();
  let pending = 0;
  for (const c of checks) {
    const name = c.name ?? c.context;
    if (c.__typename === "StatusContext") {
      if (FAILED.has(c.state)) failing.add(name);
      else if (!DONE_STATES.has(c.state)) pending++;
    } else if (c.status !== "COMPLETED") pending++;
    else if (FAILED.has(c.conclusion)) failing.add(name);
  }
  return {
    state: pr.state,
    conflict: pr.mergeable === "CONFLICTING",
    baseRefName: pr.baseRefName,
    head: pr.headRefOid,
    failing: [...failing].sort(),
    pending,
    talk: (pr.comments?.length ?? 0) + (pr.reviews?.length ?? 0),
    baseState: base?.state ?? null,
    baseHead: base?.headRefOid ?? null,
  };
}

/**
 * What changed from `before` to `now`. With no `before`, only a merge or a close: the lane read the
 * rest before it started the watch, and a check that is red by design, such as a draft's, must not wake it.
 */
export function events(before, now) {
  if (now.state === "MERGED") return ["merged"];
  if (now.state === "CLOSED") return ["closed"];
  if (!before) return [];
  const out = [];
  if (now.conflict && !before.conflict) out.push("conflict");
  const newlyFailed = now.failing.filter((name) => !before.failing.includes(name));
  if (newlyFailed.length) out.push(`check-failed: ${newlyFailed.join(", ")}`);
  if (before.pending > 0 && now.pending === 0 && now.failing.length === 0) out.push("checks-green");
  if (now.talk > before.talk) out.push("new-review");
  if (now.head !== before.head) out.push("head-moved");
  if (now.baseRefName !== before.baseRefName) out.push(`base-changed: ${now.baseRefName}`);
  else if (now.baseState === "MERGED" && before.baseState !== "MERGED") out.push("base-merged");
  else if (now.baseHead && before.baseHead && now.baseHead !== before.baseHead) out.push("base-moved");
  return out;
}

/** Looks until something changes, `maxLooks` runs out, or `maxErrors` looks fail in a row. */
export async function watch({ look, sleep, maxLooks, maxErrors = 5 }) {
  let before = null;
  let errors = 0;
  for (let i = 0; i < maxLooks; i++) {
    if (i > 0) await sleep();
    let now;
    try {
      now = await look();
      errors = 0;
    } catch (error) {
      if (++errors >= maxErrors) return { events: [`watch-error: ${String(error?.message ?? error).split("\n")[0]}`], snapshot: before };
      continue;
    }
    const found = events(before, now);
    if (found.length) return { events: found, snapshot: now };
    before = now;
  }
  return { events: ["timeout"], snapshot: before };
}

/* c8 ignore start -- process wiring */
function gh(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

function lookAt(prRef, repo) {
  const repoArgs = repo ? ["--repo", repo] : [];
  return async () => {
    const pr = gh(["pr", "view", prRef, ...repoArgs, "--json", "state,mergeable,baseRefName,headRefOid,statusCheckRollup,comments,reviews"]);
    let base = null;
    try {
      base = gh(["pr", "view", pr.baseRefName, ...repoArgs, "--json", "state,headRefOid"]);
    } catch (error) {
      // Trunk has no PR of its own. Any other failure is a failed look.
      if (!/no pull requests found/i.test(String(error?.stderr ?? ""))) throw error;
    }
    return snapshot(pr, base);
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [prRef, ...rest] = process.argv.slice(2);
  const flag = (name, fallback) => rest.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] || fallback;
  if (!prRef) {
    process.stderr.write("usage: watch-pr.mjs <pr> [--repo=<owner/name>] [--interval=<seconds>] [--hours=<n>]\n");
    process.exit(2);
  }
  const interval = Math.max(15, Number(flag("interval", 60)) || 60);
  const maxLooks = Math.ceil((Number(flag("hours", 12)) || 12) * 3600 / interval);
  const result = await watch({ look: lookAt(prRef, flag("repo")), sleep: () => delay(interval * 1000), maxLooks });
  process.stdout.write(JSON.stringify({ pr: prRef, ...result }) + "\n");
}
/* c8 ignore stop */
