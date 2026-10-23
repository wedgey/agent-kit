#!/usr/bin/env node
/**
 * Conductor's PreToolUse hook on Bash. It denies a wait loop, an unqueued heavy command
 * run directly (with the queued form to run instead), and a foreground queued command
 * whose queue has no free slot. Fails open on anything it cannot parse.
 *
 * `CONDUCTOR_HOOKS=off` in the environment or the command lets a command through. A repo
 * that runs its own queue sets `CONDUCTOR_QUEUE_MANAGED=1` in its `.claude/settings.json`
 * `env` and gets the wait-loop check only.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectInvocation, parseRunArgs, resolveSlots } from "../queue.mjs";
import { fullQueueReason, readQueueStatus } from "./full-queue.mjs";
import { bypassed, denyOutput } from "./hook-io.mjs";
import { commandSegments } from "./shell.mjs";
import { waitLoopReason } from "./wait-loop.mjs";

export const BYPASS_ENV = "CONDUCTOR_HOOKS";
export const MANAGED_ENV = "CONDUCTOR_QUEUE_MANAGED";
const QUEUE_MJS = fileURLToPath(new URL("../queue.mjs", import.meta.url));

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const INFO_ANYWHERE = new Set(["--version", "--help", "--collect-only", "--co", "--fixtures", "--markers", "--listTests", "--showConfig", "--list"]);
const PYTEST = new Set(["pytest", "py.test"]);
const WATCH = /^--(watch|watchAll|ui)(=|$)/;
const WATCH_SHORT_TOOLS = new Set(["tsc", "jest", "vitest"]);
const VITEST_NO_RUN = new Set(["watch", "dev", "list"]);
const NAME_FILTER = /^(-[ktg]|--(testNamePattern|test-name-pattern|grep|filter))(=|$)/;
const SOURCE_FILE = /\.(py|[cm]?[jt]sx?|rb|exs?|go|rs|java|kt|cs|swift)(:\d+)*$/;
const VALUE_FLAGS = new Set(["-c", "--config"]);
const SCRIPT = /^(test|build|typecheck|e2e)(:.+)?$/;
const NEVER_EXITS = /:(watch|ui|open|dev|headed)(:|$)/;
const PM_SHORT = new Set(["test", "build", "typecheck", "e2e"]);
const GRADLE_TASKS = new Set(["test", "build", "check", "assemble"]);
const MVN_GOALS = new Set(["test", "verify", "package", "install"]);
const CARGO_HEAVY = new Set(["test", "build", "check", "clippy", "nextest"]);
const GO_HEAVY = new Set(["test", "build", "vet"]);
const PM_VALUE_FLAGS = new Set(["-C", "--dir", "--prefix", "--cwd"]);
const NPM_VALUE_FLAGS = new Set([...PM_VALUE_FLAGS, "-w", "--workspace"]);
const QUEUE_TOKEN = /queue\.mjs["']?$/;

const runsAfter = (first, second) =>
  ((first === "pnpm" || first === "yarn") && (second === "exec" || second === "dlx")) ||
  ((first === "npm" || first === "bundle") && second === "exec") ||
  ((first === "uv" || first === "poetry") && second === "run");

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
    } else if (first === "timeout") {
      tokens.shift();
      while (tokens[0]?.startsWith("-")) tokens.splice(0, /^(-[sk]|--signal|--kill-after)$/.test(tokens[0]) ? 2 : 1);
      tokens.shift();
    } else if (first === "npx" || first === "bunx" || runsAfter(first, second)) {
      tokens.splice(0, first === "npx" || first === "bunx" ? 1 : 2);
      while (tokens[0]?.startsWith("-")) tokens.shift();
    } else if (first === "python" || first === "python3") {
      if (second === "-m") tokens.splice(0, 2);
      else return tokens;
    } else {
      tokens[0] = path.basename(first);
      return tokens;
    }
  }
}

const positional = (args) => args.filter((a) => !a.startsWith("-"));
const hasFilter = (args) => args.some((a) => a === "--filter" || a === "-F" || a.startsWith("--filter="));

/** A name filter, a source file or a `::` node id narrows a run. A folder does not. */
const scoped = (args) =>
  args.some((a, i) => NAME_FILTER.test(a) || (!a.startsWith("-") && !VALUE_FLAGS.has(args[i - 1]) && (a.includes("::") || SOURCE_FILE.test(a))));

/** A lone `-h` asks for help. A lone `-v` asks for the version, except to pytest, where it means verbose. */
const isShortInfo = (tool, args) => args.length === 1 && (args[0] === "-h" || (args[0] === "-v" && !PYTEST.has(tool)));

const neverQueued = (tool, args) =>
  args.some((a) => WATCH.test(a)) ||
  (WATCH_SHORT_TOOLS.has(tool) && args.includes("-w")) ||
  (tool === "vitest" && VITEST_NO_RUN.has(args[0]));

const taskQueue = (tasks) => {
  const task = tasks.find((t) => SCRIPT.test(t) && !NEVER_EXITS.test(t));
  if (!task) return null;
  return /e2e|playwright|cypress/.test(task) ? "e2e" : "tests";
};

/** The queue a head belongs in, "tests" or "e2e", or null when it is not heavy, is scoped or watches. */
export function heavyQueue(head) {
  const [tool, ...args] = head;
  if (args.some((a) => INFO_ANYWHERE.has(a)) || isShortInfo(tool, args)) return null;
  // A watch run never exits, so a queued one would hold its slot forever.
  if (neverQueued(tool, args)) return null;
  const tests = (heavy) => (heavy ? "tests" : null);
  switch (tool) {
    case "vitest":
    case "jest":
    case "mocha":
    case "pytest":
    case "py.test":
    case "rspec":
      return tests(!scoped(args));
    case "node":
      return tests(args.includes("--test") && !scoped(args));
    case "deno":
    case "mix":
    case "swift":
    case "dotnet":
      return tests((args[0] === "test" || (tool === "dotnet" && args[0] === "build")) && !scoped(args.slice(1)));
    case "tsc":
      return tests(!args.some((a) => /\.[cm]?tsx?$/.test(a)));
    case "go":
      return tests(GO_HEAVY.has(args[0]) && !args.some((a) => a === "-run" || a.startsWith("-run=")) && !positional(args.slice(1)).some((a) => !a.includes("...")));
    case "cargo": {
      const filters = args[0] === "test" ? args.slice(1) : args[0] === "nextest" ? args.slice(2) : [];
      return tests(CARGO_HEAVY.has(args[0]) && !args.some((a) => a === "-p" || a === "--package" || a.startsWith("--package=")) && positional(filters).length === 0);
    }
    case "next":
      return tests(args[0] === "build");
    case "turbo":
      return hasFilter(args) ? null : taskQueue(positional(args[0] === "run" ? args.slice(1) : args));
    case "nx":
      return args[0] === "run-many" ? taskQueue(args.slice(1).flatMap((a) => a.replace(/^--targets?=/, "").split(","))) : null;
    case "make":
      return taskQueue(positional(args));
    case "playwright":
      return args[0] === "test" && !scoped(args) ? "e2e" : null;
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
  if (hasFilter(args)) return null;
  const valueFlags = tool === "npm" ? NPM_VALUE_FLAGS : PM_VALUE_FLAGS;
  const nextWord = (from) => {
    let i = from;
    while (i < args.length && args[i].startsWith("-")) i += valueFlags.has(args[i]) ? 2 : 1;
    return i;
  };
  let at = nextWord(0);
  if (tool === "yarn" && args[at] === "workspace") at = nextWord(at + 2);
  const isRun = args[at] === "run" || args[at] === "run-script";
  const nameAt = isRun ? nextWord(at + 1) : at;
  const name = args[nameAt];
  if (name === undefined) return null;
  const forwarded = args.slice(nameAt + 1);
  if (isRun ? SCRIPT.test(name) : PM_SHORT.has(name) || (tool !== "npm" && SCRIPT.test(name))) {
    return scoped(forwarded) ? null : taskQueue([name]);
  }
  return !isRun && (tool === "pnpm" || tool === "yarn") ? heavyQueue([name, ...forwarded]) : null;
}

/** Names the queue a `queue.mjs run` segment uses, or null for anything else. */
export function classifyQueued(segment) {
  const head = commandHead(segment);
  const at = head.findIndex((t) => QUEUE_TOKEN.test(t));
  if (head[0] !== "node" || at < 0 || head[at + 1] !== "run") return null;
  const flag = head.slice(at + 2).find((t) => t.startsWith("--queue="));
  return flag ? flag.slice("--queue=".length) : "default";
}

/** The slot count a `queue.mjs run` segment will run with, resolved as queue.mjs resolves it. */
export function queuedSlots(segment, env) {
  const head = commandHead(segment);
  const parsed = parseRunArgs(head.slice(head.findIndex((t) => QUEUE_TOKEN.test(t)) + 2));
  return resolveSlots({ flag: parsed.slots, env, queue: classifyQueued(segment) });
}

/** The first segment that runs a heavy command outside the queue, as { segment, queue }, or null. */
export function findUnqueuedHeavy(command) {
  for (const segment of commandSegments(command)) {
    if (classifyQueued(segment)) continue;
    const queue = heavyQueue(commandHead(segment));
    if (queue) return { segment, queue };
  }
  return null;
}

export const shellQuote = (text) => `'${text.replaceAll("'", `'\\''`)}'`;

/** The whole command under the queue, so a `cd` or a pipe still applies. bash, because `&>` under dash backgrounds the command. */
export function queuedForm(command, queue, queueMjs = QUEUE_MJS) {
  return `node ${shellQuote(queueMjs)} run --queue=${queue} -- bash -c ${shellQuote(command)}`;
}

/**
 * Whether the repo holding `cwd` runs its own queue, from its `.claude/settings.json` `env`.
 * The session env is only a fallback outside any repo, because it stays fixed while the session moves between checkouts.
 */
export function repoManaged(cwd, env) {
  const fallback = env[MANAGED_ENV] === "1";
  if (typeof cwd !== "string" || cwd === "") return fallback;
  let top = path.resolve(cwd);
  while (!existsSync(path.join(top, ".git"))) {
    if (path.dirname(top) === top) return fallback;
    top = path.dirname(top);
  }
  try {
    return JSON.parse(readFileSync(path.join(top, ".claude", "settings.json"), "utf8"))?.env?.[MANAGED_ENV] === "1";
  } catch {
    return false;
  }
}

export function decide(input, env, deps = {}) {
  const command = input?.tool_name === "Bash" ? input.tool_input?.command : null;
  if (typeof command !== "string" || bypassed(command, env, BYPASS_ENV)) return null;
  const background = input.tool_input.run_in_background;
  const hint = `If this is a false positive, prefix the command with ${BYPASS_ENV}=off.`;
  const waiting = waitLoopReason(command, background, hint);
  if (waiting) return denyOutput(waiting);
  if (repoManaged(input.cwd, env)) return null;
  const heavy = findUnqueuedHeavy(command);
  if (heavy) {
    return denyOutput(
      `"${heavy.segment}" is a heavy command and every repo on this box shares one queue. ` +
        `Run the whole command as: ${queuedForm(command, heavy.queue, deps.queueMjs)}\n` +
        `Run it in the background and wait for the completion notice. ${hint}`,
    );
  }
  try {
    const slots = new Map();
    for (const segment of commandSegments(command)) {
      const name = classifyQueued(segment);
      if (name && !slots.has(name)) slots.set(name, queuedSlots(segment, env));
    }
    const status = deps.queueStatus ?? ((name) => readQueueStatus(env, name, slots.get(name) ?? resolveSlots({ env, queue: name })));
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
