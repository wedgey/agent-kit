// agent-kit's copy is canonical. A repo may vendor it and must keep the protocol version and state layout.
/**
 * Which Bash commands are heavy, which are already queued, and what the text alone decides.
 * Pure: no Node built-ins, so a Claude Code mod can import it as well as `decide.mjs`.
 */

import { bypassed } from "./hook-io.mjs";
import { commandSegments } from "./shell.mjs";
import { waitLoopReason } from "./wait-loop.mjs";

export const BYPASS_ENV = "CONDUCTOR_HOOKS";
export const MANAGED_ENV = "CONDUCTOR_QUEUE_MANAGED";
export const BYPASS_HINT = `If this is a false positive, prefix the command with ${BYPASS_ENV}=off.`;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const INFO_ANYWHERE = new Set(["--version", "--help", "--collect-only", "--co", "--fixtures", "--markers", "--listTests", "--showConfig", "--list"]);
const PYTEST = new Set(["pytest", "py.test"]);
const WATCH = /^--(watch|watchAll|ui)(=|$)/;
const WATCH_SHORT_TOOLS = new Set(["tsc", "jest", "vitest"]);
const VITEST_NO_RUN = new Set(["watch", "dev", "list"]);
const NAME_FILTER = /^(-[ktg]|--(testNamePattern|test-name-pattern|grep|filter))(=|$)/;
const SOURCE_FILE = /\.(py|[cm]?[jt]sx?|rb|exs?|go|rs|java|kt|cs|swift)(:\d+)*$/;
const VALUE_FLAGS = new Set(["-c", "--config"]);
const SCRIPT = /^(test|build|typecheck|e2e|ci)(:.+)?$/;
// A bare `ci` without `run` is the package manager's clean install, not the script.
const PM_INSTALL = "ci";
const NEVER_EXITS = /:(watch|ui|open|dev|headed)(:|$)/;
const PM_SHORT = new Set(["test", "build", "typecheck", "e2e"]);
const GRADLE_TASKS = new Set(["test", "build", "check", "assemble"]);
const MVN_GOALS = new Set(["test", "verify", "package", "install"]);
const CARGO_HEAVY = new Set(["test", "build", "check", "clippy", "nextest"]);
const GO_HEAVY = new Set(["test", "build", "vet"]);
const PM_VALUE_FLAGS = new Set(["-C", "--dir", "--prefix", "--cwd"]);
const NPM_VALUE_FLAGS = new Set([...PM_VALUE_FLAGS, "-w", "--workspace"]);
export const QUEUE_TOKEN = /queue\.mjs["']?$/;

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
      tokens[0] = first.slice(first.lastIndexOf("/") + 1);
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

/**
 * The queue a head belongs in, "tests" or "e2e", or null when it is not heavy, is scoped or watches.
 * Scoping frees only the tests queue: every e2e run boots a dev server and a browser whatever its scope.
 */
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
      return args[0] === "test" ? "e2e" : null;
    case "cypress":
      return args[0] === "run" ? "e2e" : null;
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
  if (isRun ? SCRIPT.test(name) : PM_SHORT.has(name) || (tool !== "npm" && name !== PM_INSTALL && SCRIPT.test(name))) {
    const queue = taskQueue([name]);
    return queue === "e2e" || !scoped(forwarded) ? queue : null;
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
export function queuedForm(command, queue, queueMjs) {
  return `node ${shellQuote(queueMjs)} run --queue=${queue} -- bash -c ${shellQuote(command)}`;
}

/** Whether any segment already runs through `queue.mjs run`. */
export const hasQueued = (command) => commandSegments(command).some((s) => classifyQueued(s) !== null);

/**
 * What the command text alone decides: `{ pass: true }`, `{ deny }` for a wait loop, or
 * `{ host: true }` when only the queue's state can decide (a heavy or a queued command).
 * `env` needs only `CI` and `CONDUCTOR_HOOKS`.
 */
export function triage(command, background, env) {
  if (typeof command !== "string" || bypassed(command, env, BYPASS_ENV)) return { pass: true };
  const waiting = waitLoopReason(command, background, BYPASS_HINT);
  if (waiting) return { deny: waiting };
  return findUnqueuedHeavy(command) || hasQueued(command) ? { host: true } : { pass: true };
}
