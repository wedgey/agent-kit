// Conductor's queue on Bash calls. The command text is triaged here, in the module; only a heavy
// or queued command reaches Node, through decide.mjs, which reads the queue. Wait loops are left
// to the PreToolUse command hook, which holds even where mods do not load.
import { queuedBodies, triage } from "../skills/conductor/tools/hooks/classify.mjs";

/** The setup doctor's probe: only a loaded mod answers it. */
const PROBE = ": conductor-mod-probe";

/** The engine's permission verdict for a command under the session's mode and rules, or null. */
async function verdict($, command) {
  try {
    return await $.tool.check({ tool: "Bash", input: { command } });
  } catch {
    return null;
  }
}

/** @type {import('claude-code').Register} */
export const register = (on) => {
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    if (e.command.trim() === PROBE) return { deny: "conductor's Bash mod is loaded." };
    const env = { CI: await $.env.get("CI"), CONDUCTOR_HOOKS: await $.env.get("CONDUCTOR_HOOKS") };
    const background = e.run_in_background === true;
    const first = triage(e.command, background, env);
    if (!first.host) return next(e);
    // A rule allowing `node queue.mjs run` must not launder a body that a rule denies.
    for (const body of queuedBodies(e.command)) {
      const v = await verdict($, body);
      if (v?.decision === "deny") return { deny: `${v.reason ?? "A permission rule denies this command."} (${v.rule ?? "a deny rule"}, on the command inside queue.mjs run)` };
    }
    const cwd = await $.session.cwd();
    const input = { tool_name: "Bash", tool_input: { command: e.command, run_in_background: background }, cwd, session: await $.session.id() };
    const ran = await $.process.run(["node", `${$.plugin.root}/skills/conductor/tools/hooks/decide.mjs`], {
      cwd,
      stdin: JSON.stringify(input),
      timeoutMs: 10_000,
    });
    const out = ran.exitCode === 0 && ran.stdout.trim() ? JSON.parse(ran.stdout) : {};
    if (typeof out.deny === "string") return { deny: out.deny };
    if (typeof out.command !== "string") return next(e);
    // Rules and prompts match the text that runs, so rewrite only what the session runs unasked in
    // both forms: a denied original goes to core as typed, to be denied by its own rule.
    const original = await verdict($, e.command);
    if (original?.decision === "deny") return next(e);
    if (original?.decision !== "allow" || (await verdict($, out.command))?.decision !== "allow") return { deny: out.suggest };
    return next({ ...e, command: out.command });
  }).catch(($, e, next) => {
    // The queue must never block the work it schedules: on any failure the command runs as it was.
    $.ui.log("conductor: the queue check failed; the command ran unqueued", { to: "debug" });
    return next(e);
  });
};
