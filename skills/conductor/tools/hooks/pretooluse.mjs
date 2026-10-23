#!/usr/bin/env node
/**
 * Conductor's PreToolUse hook on Bash. It denies a wait loop, an unqueued heavy command
 * run directly (with the queued form to run instead), and a foreground queued command
 * whose queue has no free slot. Fails open on anything it cannot parse.
 *
 * `CONDUCTOR_HOOKS=off` in the environment or the command lets a command through. A repo
 * that runs its own queue sets `CONDUCTOR_QUEUE_MANAGED=1` and gets the wait-loop check only.
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SLOTS_ENV_PREFIX, isDirectInvocation, queueDir } from "../queue.mjs";
import { fullQueueReason, readQueueStatus } from "./full-queue.mjs";
import { bypassed, denyOutput } from "./hook-io.mjs";
import { commandSegments } from "./shell.mjs";
import { waitLoopReason } from "./wait-loop.mjs";

export const BYPASS_ENV = "CONDUCTOR_HOOKS";
export const MANAGED_ENV = "CONDUCTOR_QUEUE_MANAGED";
const QUEUE_MJS = fileURLToPath(new URL("../queue.mjs", import.meta.url));

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_\w+\.py$|_test\.(go|py)$/;
const INFO_FLAGS = new Set(["--version", "-v", "--help", "-h"]);
const SCRIPT = /^(test|build|typecheck|e2e)(:(?!watch).+)?$/;
const PM_SHORT = new Set(["test", "build", "typecheck", "e2e"]);
const GRADLE_TASKS = new Set(["test", "build", "check", "assemble"]);
const MVN_GOALS = new Set(["test", "verify", "package", "install"]);

/** The tool a segment runs and its arguments, with env, wrappers and runners peeled off. */
export function commandHead(segment) {
  const tokens = segment.split(/\s+/).filter(Boolean);
  for (;;) {
    const [first, second] = tokens;
    if (first === undefined) return tokens;
    if (ASSIGNMENT.test(first) || first === "time" || first === "env") tokens.shift();
    else if (first === "nice") {
      tokens.shift();
      if (tokens[0] === "-n") tokens.splice(0, 2);
      else if (/^-n?\d+$/.test(tokens[0] ?? "")) tokens.shift();
    } else if (first === "timeout") tokens.splice(0, 2);
    else if (first === "npx" || first === "bunx") {
      tokens.shift();
      while (tokens[0]?.startsWith("-")) tokens.shift();
    } else if ((first === "pnpm" || first === "yarn") && (second === "exec" || second === "dlx")) tokens.splice(0, 2);
    else if (first === "python" || first === "python3") {
      if (second === "-m") tokens.splice(0, 2);
      else {
        tokens[0] = first;
        return tokens;
      }
    } else {
      tokens[0] = path.basename(first);
      return tokens;
    }
  }
}

const positional = (args) => args.filter((a) => !a.startsWith("-"));
const scopedByPath = (args) => args.some((a) => !a.startsWith("-") && (TEST_FILE.test(a) || a.includes("/") || a.includes("::")));

/** The queue a head belongs in, "tests" or "e2e", or null when it is not heavy or is scoped. */
export function heavyQueue(head) {
  const [tool, ...args] = head;
  if (args.some((a) => INFO_FLAGS.has(a))) return null;
  const tests = (heavy) => (heavy ? "tests" : null);
  switch (tool) {
    case "vitest":
    case "jest":
    case "mocha":
    case "pytest":
    case "py.test":
      return tests(!scopedByPath(args));
    case "tsc":
      return tests(!args.some((a) => /\.[cm]?tsx?$/.test(a)));
    case "go":
      return tests(args[0] === "test" && !args.some((a) => a === "-run" || a.startsWith("-run=")) && !positional(args.slice(1)).some((a) => !a.includes("...")));
    case "cargo":
      return tests(["test", "build"].includes(args[0]) && !args.some((a) => a === "-p" || a === "--package" || a.startsWith("--package=")) && !(args[0] === "test" && positional(args.slice(1)).length > 0));
    case "next":
      return tests(args[0] === "build");
    case "playwright":
      return args[0] === "test" && !scopedByPath(args) && !args.some((a) => a === "-g" || a.startsWith("--grep")) ? "e2e" : null;
    case "cypress":
      return args[0] === "run" && !args.some((a) => a === "--spec" || a.startsWith("--spec=")) ? "e2e" : null;
    case "gradle":
    case "gradlew":
      return tests(args.some((a) => GRADLE_TASKS.has(a)) && !args.includes("--tests"));
    case "mvn":
    case "mvnw":
      return tests(args.some((a) => MVN_GOALS.has(a)) && !args.some((a) => a.startsWith("-Dtest")));
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return packageScriptQueue(tool, args);
    default:
      return null;
  }
}

function packageScriptQueue(tool, args) {
  if (args.some((a) => a === "--filter" || a === "-F" || a.startsWith("--filter="))) return null;
  const rest = args.filter((a) => !a.startsWith("-") || a === "--");
  const at = rest[0] === "run" || rest[0] === "run-script" ? 1 : 0;
  const name = rest[at];
  if (!name || !(at === 1 ? SCRIPT.test(name) : PM_SHORT.has(name) || (tool !== "npm" && SCRIPT.test(name)))) return null;
  if (scopedByPath(rest.slice(at + 1))) return null;
  return /e2e|playwright|cypress/.test(name) ? "e2e" : "tests";
}

/** The first segment that runs a heavy command outside the queue, as { segment, queue }, or null. */
export function findUnqueuedHeavy(command) {
  if (command.includes("queue.mjs")) return null;
  for (const segment of commandSegments(command)) {
    const queue = heavyQueue(commandHead(segment));
    if (queue) return { segment, queue };
  }
  return null;
}

export const shellQuote = (text) => `'${text.replaceAll("'", `'\\''`)}'`;

const positiveInt = (v) => {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** `CONDUCTOR_QUEUE_SLOTS_<QUEUE>`, else tests = a quarter of the cores (at least 1), else 1. */
export function defaultSlots(queue, env, cores = os.availableParallelism?.() ?? os.cpus().length) {
  const fromEnv = positiveInt(env[SLOTS_ENV_PREFIX + queue.toUpperCase().replace(/[^A-Z0-9]/g, "_")]);
  if (fromEnv) return fromEnv;
  return queue === "tests" ? Math.max(1, Math.floor(cores / 4)) : 1;
}

export function queuedForm({ segment, queue }, env, queueMjs = QUEUE_MJS) {
  return `node ${shellQuote(queueMjs)} run --queue=${queue} --slots=${defaultSlots(queue, env)} -- sh -c ${shellQuote(segment)}`;
}

/** Names the queue a `queue.mjs run` segment uses, or null for anything else. */
export function classifyQueued(segment) {
  const head = commandHead(segment);
  const at = head.findIndex((t) => /queue\.mjs["']?$/.test(t));
  if (head[0] !== "node" || at < 0 || head[at + 1] !== "run") return null;
  const flag = head.slice(at + 2).find((t) => t.startsWith("--queue="));
  return flag ? flag.slice("--queue=".length) : "default";
}

function liveStatus(env, segmentSlots) {
  return (name) => readQueueStatus(env, name, segmentSlots(name));
}

export function decide(input, env, deps = {}) {
  const command = input?.tool_name === "Bash" ? input.tool_input?.command : null;
  if (typeof command !== "string" || bypassed(command, env, BYPASS_ENV)) return null;
  const background = input.tool_input.run_in_background;
  const hint = `If this is a false positive, prefix the command with ${BYPASS_ENV}=off.`;
  const waiting = waitLoopReason(command, background, hint);
  if (waiting) return denyOutput(waiting);
  if (env[MANAGED_ENV] === "1") return null;
  const heavy = findUnqueuedHeavy(command);
  if (heavy) {
    return denyOutput(
      `"${heavy.segment}" is a heavy command and every repo on this box shares one queue. ` +
        `Run it as: ${queuedForm(heavy, env, deps.queueMjs)}\n` +
        `Run it in the background and wait for the completion notice. ${hint}`,
    );
  }
  try {
    const status = deps.queueStatus ?? liveStatus(env, (name) => defaultSlots(name, env));
    const full = fullQueueReason(command, background, (name) => {
      try {
        return status(name);
      } catch {
        return null;
      }
    }, deps.classify ?? classifyQueued);
    return full ? denyOutput(full) : null;
  } catch {
    return null;
  }
}

/* c8 ignore start -- process wiring */
if (isDirectInvocation(process.argv[1], import.meta.url)) {
  let out = null;
  try {
    out = decide(JSON.parse(readFileSync(0, "utf8")), process.env);
  } catch {}
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
/* c8 ignore stop */
