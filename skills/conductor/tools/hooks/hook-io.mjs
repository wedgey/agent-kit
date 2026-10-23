// agent-kit's copy is canonical. A repo may vendor it and must keep the protocol version and state layout.
/** Shared hook plumbing: the deny payload and the bypass test. */

export function denyOutput(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/** Bypassed in CI, by `<bypassEnv>=off` in the session, or by that assignment in the command. */
export function bypassed(command, env, bypassEnv) {
  return Boolean(env.CI) || env[bypassEnv] === "off" || command.includes(`${bypassEnv}=off`);
}
