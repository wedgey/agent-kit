#!/usr/bin/env node
// agent-kit's copy is canonical. A repo may vendor it and must keep the protocol version and state layout.
/**
 * A PreToolUse command hook on Bash that warns when an e2e spec is rerun with no look since the
 * last e2e run in the same worktree. An `agent-browser` call is a look. CONDUCTOR_LOOK_GATE=deny
 * denies instead, =off silences it; E2E_NO_LOOK="<reason>" in the command passes one run.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { BYPASS_ENV, classifyQueued, commandHead, findUnqueuedHeavy } from "./classify.mjs";
import { bypassed } from "./hook-io.mjs";
import { commandSegments } from "./shell.mjs";
import { isDirectInvocation } from "../queue.mjs";

export const MODE_ENV = "CONDUCTOR_LOOK_GATE";
export const ESCAPE = "E2E_NO_LOOK=";
const SPEC = /\.spec\.|\.e2e\.|(^|\/)e2e\//;
const STDOUT_REDIRECT = /(?:^|\s)(?:1?>>?|&>>?)\s*([^\s&|;'"<>]+)/g;
const REACHED_A_TEST = /\b\d+ (?:passed|failed|flaky|passing|failing)\b|[✓✘]/;
// A heavy call the queue mod denies comes straight back queued; that retry is the same run and gets the same answer.
const SAME_RUN_MS = 120_000;
// Lane worktree paths are reused; a run older than this belongs to an earlier lane.
const STALE_MS = 12 * 3_600_000;

export const MESSAGE =
  "This reruns an e2e spec with no look since its last run in this worktree. Look at the failing step first: drive it with agent-browser against the dev server this worktree keeps warm, and rerun the spec once the look shows the fix. If a look cannot help, prefix the command with E2E_NO_LOOK=\"<reason>\".";

const isE2e = (segments, command) => findUnqueuedHeavy(command)?.queue === "e2e" || segments.some((s) => classifyQueued(s) === "e2e");

function git(cwd, args, env = {}) {
  const out = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  if (out.status !== 0) throw new Error(`git ${args[0]} failed`);
  return out.stdout.trim();
}

/** The worktree's tree as it stands, untracked files included, from an index of our own so the worktree's is untouched. */
function workingTree(top, index, retry = true) {
  try {
    if (!existsSync(index)) {
      const real = git(top, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
      if (existsSync(real)) copyFileSync(real, index);
    }
    git(top, ["add", "-A"], { GIT_INDEX_FILE: index });
    return git(top, ["write-tree"], { GIT_INDEX_FILE: index });
  } catch (error) {
    rmSync(index, { force: true });
    if (retry) return workingTree(top, index, false);
    throw error;
  }
}

/** The first file the command sends stdout to, resolved against a leading `cd <dir>` if there is one. */
function logTarget(segments, command, cwd) {
  const cd = /^cd\s+(\S+)$/.exec(segments[0]?.trim() ?? "")?.[1];
  const base = cd ? resolve(cwd, cd) : cwd;
  for (const [, target] of command.matchAll(STDOUT_REDIRECT)) {
    if (!target.startsWith("/dev/")) return resolve(base, target);
  }
  return null;
}

function neverReachedATest(log) {
  return Boolean(log) && existsSync(log) && !REACHED_A_TEST.test(readFileSync(log, "utf8"));
}

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function changedSince(top, last, tree) {
  try {
    const log = last.log ? relative(top, last.log) : null;
    return git(top, ["diff", "--name-only", last.tree, tree]).split("\n").filter((f) => f && f !== log);
  } catch {
    return [];
  }
}

function output(mode) {
  const hookSpecificOutput = { hookEventName: "PreToolUse" };
  if (mode === "deny") Object.assign(hookSpecificOutput, { permissionDecision: "deny", permissionDecisionReason: MESSAGE });
  else hookSpecificOutput.additionalContext = MESSAGE;
  return { hookSpecificOutput };
}

/** The hook output for a Bash call, or null to stay silent. Records looks and e2e runs per worktree. */
export function lookGateDecision(input, env, { stateDir = join(tmpdir(), "conductor-look-gate"), now = Date.now() } = {}) {
  const command = input?.tool_name === "Bash" ? input.tool_input?.command : null;
  const mode = env[MODE_ENV] ?? "warn";
  if (typeof command !== "string" || mode === "off" || bypassed(command, env, BYPASS_ENV)) return null;
  const segments = commandSegments(command);
  const look = segments.some((s) => commandHead(s)[0] === "agent-browser");
  const e2e = isE2e(segments, command);
  if (!look && !e2e) return null;

  const cwd = input.cwd ?? process.cwd();
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  mkdirSync(stateDir, { recursive: true });
  const key = join(stateDir, createHash("sha1").update(top).digest("hex"));
  const file = `${key}.json`;
  const state = readState(file);
  if (look) state.lookSince = true;
  if (!e2e) {
    writeFileSync(file, JSON.stringify(state));
    return null;
  }

  const tree = workingTree(top, `${key}.index`);
  const last = state.lastRun && now - state.lastRun.at < STALE_MS ? state.lastRun : null;
  const escaped = command.includes(ESCAPE);
  if (last?.tree === tree && now - last.at < SAME_RUN_MS && !state.lookSince && !escaped) return last.warned ? output(mode) : null;
  const changed = last ? changedSince(top, last, tree) : [];
  const specOnly = changed.length > 0 && changed.every((f) => SPEC.test(f));
  const warned = !(!last || state.lookSince || specOnly || last.specOnly || neverReachedATest(last.log) || escaped);
  writeFileSync(file, JSON.stringify({ lastRun: { tree, at: now, specOnly, warned, log: logTarget(segments, command, cwd) }, lookSince: false }));
  return warned ? output(mode) : null;
}

/* c8 ignore start -- process wiring */
if (isDirectInvocation(process.argv[1], import.meta.url)) {
  let out = null;
  try {
    out = lookGateDecision(JSON.parse(readFileSync(0, "utf8")), process.env);
  } catch {}
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
/* c8 ignore stop */
