// agent-kit's copy is canonical. A repo may vendor it and must keep the protocol version and state layout.
/**
 * Which Bash commands are heavy, which are already queued, and what the text alone decides.
 * Pure: no Node built-ins, so a Claude Code mod can import it as well as `decide.mjs`.
 */

import { bypassed } from "./hook-io.mjs";
import { commandSegments, segments, shellBodies, shellWords, withoutHeredocs } from "./shell.mjs";
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

const KEYWORDS = new Set(["(", "{", "}", "!", "if", "then", "elif", "else", "while", "until", "do"]);
const PASS_THROUGH = new Set(["nohup", "exec", "command"]);
const ENV_VALUE_FLAGS = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);

/** Drops the flags a wrapper takes before the command it runs; `valued` flags take the next token. */
function dropFlags(tokens, valued) {
  while (tokens[0]?.startsWith("-") && tokens[0] !== "-") tokens.splice(0, valued(tokens[0]) ? 2 : 1);
}

/** The tool a segment runs and its arguments, with env, wrappers, runners and shell keywords peeled off. */
export function commandHead(segment) {
  const tokens = segment.replace(/^[\s(]+/, "").replace(/[\s)]+$/, "").split(/\s+/).filter(Boolean);
  for (;;) {
    const [first, second] = tokens;
    if (first === undefined) return tokens;
    if (KEYWORDS.has(first) || ASSIGNMENT.test(first)) tokens.shift();
    else if (first === "time") {
      tokens.shift();
      dropFlags(tokens, () => false);
    } else if (first === "env") {
      tokens.shift();
      dropFlags(tokens, (f) => ENV_VALUE_FLAGS.has(f));
    } else if (PASS_THROUGH.has(first)) {
      // `command -v x` looks x up and runs nothing: its head stays the flag.
      if (first === "command" && /^-[vV]$/.test(second ?? "")) return tokens;
      tokens.shift();
      dropFlags(tokens, (f) => f === "-a");
    } else if (first === "stdbuf") {
      tokens.shift();
      dropFlags(tokens, (f) => /^-[ioe]$/.test(f));
    } else if (first === "nice") {
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

const SHELL = /^(?:ba|z|da)?sh$/;

/** The quoted bodies of a `sh|bash -c '...'` segment, or none. */
const bodiesOf = (segment) => (SHELL.test(commandHead(segment)[0] ?? "") ? shellBodies(segment) : []);

/**
 * The first segment that runs a heavy command outside the queue, as { segment, queue, index },
 * or null. A `bash -c '...'` body counts as the segment it sits in; `index` is the outer segment's.
 */
export function findUnqueuedHeavy(command) {
  const segments = commandSegments(command);
  for (const [index, segment] of segments.entries()) {
    if (classifyQueued(segment)) continue;
    const queue = heavyQueue(commandHead(segment));
    if (queue) return { segment, queue, index };
    for (const body of bodiesOf(segment)) {
      const inner = findUnqueuedHeavy(body);
      if (inner) return { ...inner, index };
    }
  }
  return null;
}

const REDIRECT = /\s+\d*(?:>{1,2}|&>|<)&?\s*\S+/g;
const normalized = (text) => text.replace(REDIRECT, "").replace(/\s+/g, " ").trim();

/**
 * What a duplicate is judged by: the segments up to and including the heavy one, redirects
 * dropped and what follows (`| tail -40`) ignored, so two runs that differ only there are one.
 * A `bash -c` body is keyed on itself. Without a heavy segment, the whole command.
 */
export function dupeKey(command) {
  const segments = commandSegments(command);
  const heavy = findUnqueuedHeavy(command);
  if (!heavy) return normalized(command);
  const last = segments[heavy.index];
  const head = bodiesOf(last).length && !heavyQueue(commandHead(last)) ? dupeKey(bodiesOf(last).find((b) => findUnqueuedHeavy(b))) : normalized(last);
  return [...segments.slice(0, heavy.index).map(normalized), head].join(" && ");
}

const HEREDOC = /^([^\n]*?)<<-?[ \t]*(['"]?)(\w+)\2[ \t]*\n([\s\S]*?)\n[ \t]*\3[ \t]*$/;
const PLAIN_WORD = /^[\w@%+=:,./-]+$/;
const UNWRAPPED = /^(?:ba)?sh$/;
const READ_ONLY_SUBCOMMANDS = new Set(["status", "stop", "move"]);

/** Drops quotes and backslashes, `$'..'` and `$".."` included, so quoting cannot hide a word. */
const unquoted = (text) => text.replaceAll("\\\n", "").replaceAll("$'", "'").replaceAll('$"', '"').replace(/['"\\]/g, "");

/** Whether a segment calls `node .../queue.mjs` with any subcommand but status, stop or move. */
function callsQueue(segment) {
  const head = commandHead(unquoted(segment));
  const at = head.findIndex((t) => t.endsWith("queue.mjs"));
  return head[0] === "node" && at > 0 && !READ_ONLY_SUBCOMMANDS.has(head[at + 1]);
}

/** Whether any command start in the text, heredoc bodies and quoted text aside, calls the queue. */
const typesQueued = (command) => segments(withoutHeredocs(command), true).some(callsQueue);

/** The argv after a `queue.mjs run ... --`, or null when the text is not exactly that one call. */
function queuedArgv(text) {
  const words = shellWords(text);
  const sep = words?.indexOf("--") ?? -1;
  return words && words[0] === "node" && QUEUE_TOKEN.test(words[1] ?? "") && words[2] === "run" && sep > 2 ? words.slice(sep + 1) : null;
}

/** What a queued argv runs as `{ body }`, or `{ error, plain? }`. Only bash and sh scripts are unwrapped. */
function bodyOf(argv) {
  if (!argv?.length) return { error: "it is not one plain queue.mjs run call with -- before the command" };
  const shell = argv[0].slice(argv[0].lastIndexOf("/") + 1);
  if (UNWRAPPED.test(shell) && (argv.length !== 3 || argv[1] !== "-c")) {
    const flags = argv.slice(1, -1);
    const flagged = flags.length > 0 && flags.every((f) => /^-[a-z]*$/.test(f)) && flags.some((f) => f.includes("c"));
    return { error: `${argv[0]} does not run exactly one -c script`, ...(flagged ? { plain: argv.at(-1) } : {}) };
  }
  // A first word holding `=` is a file queue.mjs spawns, not an assignment, so it stays quoted.
  const body = UNWRAPPED.test(shell) ? argv[2] : argv.map((w, i) => (PLAIN_WORD.test(w) && !(i === 0 && w.includes("=")) ? w : shellQuote(w))).join(" ");
  return typesQueued(body) ? { error: "it runs another queue.mjs run inside" } : { body };
}

/** The command with its one typed queued call replaced by the body, when that body is one simple command. */
function joinedPlain(command) {
  const calls = commandSegments(command).filter(callsQueue);
  if (calls.length !== 1) return {};
  const call = calls[0].replace(REDIRECT, "");
  const { body } = bodyOf(queuedArgv(call));
  return body && commandSegments(body).length === 1 && command.includes(call) ? { plain: command.replace(call, () => body) } : {};
}

/**
 * What a typed `node .../queue.mjs run` form runs, read as the shell reads it: null when the
 * command has none, `{ body }` when it is one plain call, else `{ error, plain? }`, `plain` being
 * the command to type instead when it can be recovered.
 */
export function typedQueued(command) {
  if (!typesQueued(command)) return null;
  const heredoc = HEREDOC.exec(command);
  if (heredoc) {
    const argv = queuedArgv(heredoc[1]);
    return { error: "it feeds a script on stdin", ...(argv?.length === 1 && UNWRAPPED.test(argv[0]) ? { plain: heredoc[4] } : {}) };
  }
  const argv = queuedArgv(command);
  return argv ? bodyOf(argv) : { error: "it is not one plain queue.mjs run call with -- before the command", ...joinedPlain(command) };
}

/** The body a typed queued form runs: [] for none, null when it cannot be read and must be denied. */
export function queuedBodies(command) {
  const typed = typedQueued(command);
  return typed === null ? [] : typed.body === undefined ? null : [typed.body];
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
