#!/usr/bin/env node
// agent-kit's copy is canonical. A repo may vendor it and must keep the protocol version and state layout.
/**
 * A PreToolUse command hook on Bash that only denies a wait loop. It needs no mod support, so
 * the wait-loop check holds wherever command hooks run; the mod leaves wait loops to it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BYPASS_ENV, BYPASS_HINT } from "./classify.mjs";
import { bypassed } from "./hook-io.mjs";
import { waitLoopReason } from "./wait-loop.mjs";

export function waitLoopDecision(input, env) {
  const command = input?.tool_name === "Bash" ? input.tool_input?.command : null;
  if (typeof command !== "string" || bypassed(command, env, BYPASS_ENV)) return null;
  const reason = waitLoopReason(command, input.tool_input.run_in_background, BYPASS_HINT);
  return reason ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } } : null;
}

/* c8 ignore start -- process wiring */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let out = null;
  try {
    out = waitLoopDecision(JSON.parse(readFileSync(0, "utf8")), process.env);
  } catch {}
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
/* c8 ignore stop */
