#!/usr/bin/env node
// agent-kit's copy is canonical. A repo may vendor it and must keep the protocol version and state layout.
/**
 * A PreToolUse command hook on Bash that warns when an e2e spec is rerun with no look since the
 * last e2e run in the same worktree. An `agent-browser` call is a look. CONDUCTOR_LOOK_GATE=deny
 * denies instead, =off silences it; E2E_NO_LOOK="<reason>" in the command passes one run.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { BYPASS_ENV, classifyQueued, findUnqueuedHeavy } from "./classify.mjs";
import { bypassed } from "./hook-io.mjs";
import { commandSegments } from "./shell.mjs";
import { isDirectInvocation } from "../queue.mjs";

export const MODE_ENV = "CONDUCTOR_LOOK_GATE";
export const ESCAPE = "E2E_NO_LOOK=";
const LOOK = /\bagent-browser\b/;
const SPEC = /\.spec\.|\.e2e\.|(^|\/)e2e\//;
const REDIRECT = /(?:^|\s)(?:\d?>>?|&>>?)\s*([^\s&|;'"<>]+)/g;
const REACHED_A_TEST = /\b\d+ (?:passed|failed|flaky)\b|[✓✘]/;
const PREFLIGHT_REFUSAL = /MB available/;
// A heavy call the queue mod denies comes straight back queued; that retry is the same run.
const SAME_RUN_MS = 120_000;

export const MESSAGE =
  "This reruns an e2e spec with no look since its last run in this worktree. Look at the failing step first: drive it with agent-browser against the dev server this worktree keeps warm, and rerun the spec once the look shows the fix. If a look cannot help, prefix the command with E2E_NO_LOOK=\"<reason>\".";

const isE2e = (command) => findUnqueuedHeavy(command)?.queue === "e2e" || commandSegments(command).some((s) => classifyQueued(s) === "e2e");

function git(cwd, args, env = {}) {
  const out = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  if (out.status !== 0) throw new Error(`git ${args[0]} failed`);
  return out.stdout.trim();
}

/** The worktree's tree as it stands, untracked files included, from an index of our own so the worktree's is untouched. */
function workingTree(top, index) {
  if (!existsSync(index)) {
    const real = git(top, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    if (existsSync(real)) copyFileSync(real, index);
  }
  git(top, ["add", "-A"], { GIT_INDEX_FILE: index });
  return git(top, ["write-tree"], { GIT_INDEX_FILE: index });
}

/** The first file the command redirects output into, resolved against the worktree. */
function logTarget(command, cwd) {
  for (const [, target] of command.matchAll(REDIRECT)) {
    if (!target.startsWith("/dev/")) return isAbsolute(target) ? target : join(cwd, target);
  }
  return null;
}

function neverReachedATest(log) {
  if (!log || !existsSync(log)) return false;
  const text = readFileSync(log, "utf8");
  return PREFLIGHT_REFUSAL.test(text) || !REACHED_A_TEST.test(text);
}

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** The hook output for a Bash call, or null to stay silent. Records looks and e2e runs per worktree. */
export function lookGateDecision(input, env, { stateDir = join(tmpdir(), "conductor-look-gate"), now = Date.now() } = {}) {
  const command = input?.tool_name === "Bash" ? input.tool_input?.command : null;
  const mode = env[MODE_ENV] ?? "warn";
  if (typeof command !== "string" || mode === "off" || bypassed(command, env, BYPASS_ENV)) return null;
  const look = LOOK.test(command);
  if (!look && !isE2e(command)) return null;

  const cwd = input.cwd ?? process.cwd();
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  mkdirSync(stateDir, { recursive: true });
  const key = join(stateDir, createHash("sha1").update(top).digest("hex"));
  const file = `${key}.json`;
  const state = readState(file);
  if (look) {
    writeFileSync(file, JSON.stringify({ ...state, lookSince: true }));
    return null;
  }

  const tree = workingTree(top, `${key}.index`);
  const last = state.lastRun;
  if (last?.tree === tree && now - last.at < SAME_RUN_MS) return null;
  const changed = last ? git(top, ["diff", "--name-only", last.tree, tree]).split("\n").filter(Boolean) : [];
  const specOnly = changed.length > 0 && changed.every((f) => SPEC.test(f));
  const excused = !last || state.lookSince || specOnly || last.specOnly || neverReachedATest(last.log) || command.includes(ESCAPE);
  writeFileSync(file, JSON.stringify({ lastRun: { tree, at: now, specOnly, log: logTarget(command, cwd) }, lookSince: false }));
  if (excused) return null;
  const hookSpecificOutput = { hookEventName: "PreToolUse" };
  if (mode === "deny") Object.assign(hookSpecificOutput, { permissionDecision: "deny", permissionDecisionReason: MESSAGE });
  else hookSpecificOutput.additionalContext = MESSAGE;
  return { hookSpecificOutput };
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
