// agent-kit's copy is canonical. A repo may vendor it and must keep the protocol version and state layout.
/**
 * Detects a Bash command that blocks the turn by waiting: a `until|while|for` loop that
 * sleeps, a long `sleep` chained with other commands, or a foreground watcher
 * (`gh run watch`, `watch`, `tail -f | grep -m`). Returns the deny reason.
 */

import { codeOnly, segments, shellBodies } from "./shell.mjs";

const LONG_SLEEP_SECONDS = 30;
// Quadratic on a long separator-free line, so these are skipped past this size (fail open).
const WATCHER_MAX_CODE = 4000;
const WATCHERS = [
  /(?<![\w./-])gh\s+pr\s+checks\b[^;&|]*--watch/,
  /(?<![\w./-])gh\s+run\s+watch\b/,
  /(?:^|[;&|(]\s*)(?:timeout\s+\S+\s+)?watch\s+\S/,
  /(?<![\w./-])tail\s+(?:-\w*[fF]\w*|--follow\S*)[^;&|]*\|\s*grep\b[^;&|]*(?:\s-\w*m|--max-count)/,
];
const SEPARATOR = /^[;&|()]$/;

/** One pass: a `do` arms the loop, a `sleep` with an argument marks it, `done` closes it. */
function sleepsInLoop(code) {
  const tokens = code.match(/[^\s;&|()]+|[;&|()]/g) ?? [];
  let armed = false;
  let slept = false;
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === "do") {
      armed = true;
      slept = false;
    } else if (tokens[i] === "sleep" && armed && tokens[i + 1] && !SEPARATOR.test(tokens[i + 1])) {
      slept = true;
    } else if (tokens[i] === "done") {
      if (armed && slept) return true;
      armed = false;
    }
  }
  return false;
}
const UNIT_SECONDS = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

export const WAIT_LOOP_REASON =
  "Do not block the turn by sleeping or polling. Run the thing you are waiting on with " +
  "run_in_background: true and wait for its completion notice; to wait for a condition, " +
  "use the Monitor tool.";

function sleepSeconds(segment) {
  const [head, ...args] = segment.split(/\s+/);
  if (head !== "sleep" || args.length === 0) return 0;
  let total = 0;
  for (const arg of args) {
    const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(arg);
    if (!m) return 0;
    total += Number(m[1]) * UNIT_SECONDS[m[2]];
  }
  return total;
}

/** `bypassHint` is a sentence the caller appends, so this file names no repo's env var. */
function waits(code) {
  const parts = segments(code);
  return (
    sleepsInLoop(code) ||
    (code.length <= WATCHER_MAX_CODE && WATCHERS.some((re) => re.test(code))) ||
    (parts.length > 1 && parts.some((s) => sleepSeconds(s) >= LONG_SLEEP_SECONDS))
  );
}

/** `bypassHint` is a sentence the caller appends, so this file names no repo's env var. */
export function waitLoopReason(command, runInBackground, bypassHint = "") {
  if (runInBackground === true) return null;
  const found = [command, ...shellBodies(command)].some((text) => waits(codeOnly(text)));
  return found ? `${WAIT_LOOP_REASON} ${bypassHint}`.trim() : null;
}
