// Conductor's one decision point on Bash calls. The command text is triaged here, in the
// module; only a heavy or queued command reaches Node, through decide.mjs, which reads the queue.
import { triage } from "../skills/conductor/tools/hooks/classify.mjs";

/**
 * Whether the session runs the queued form without asking anyone: the engine's own verdict for
 * its mode and rules. Under any other verdict the person's prompt would show the queued form,
 * not what the model asked for, so the call is denied with that form to run instead.
 */
async function autoApproved($, command) {
  try {
    return (await $.tool.check({ tool: "Bash", input: { command } })).decision === "allow";
  } catch {
    return false;
  }
}

/** @type {import('claude-code').Register} */
export const register = (on) => {
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const env = { CI: await $.env.get("CI"), CONDUCTOR_HOOKS: await $.env.get("CONDUCTOR_HOOKS") };
    const background = e.run_in_background === true;
    const first = triage(e.command, background, env);
    if (first.deny) return { deny: first.deny };
    if (first.pass) return next(e);
    const cwd = await $.session.cwd();
    const input = { tool_name: "Bash", tool_input: { command: e.command, run_in_background: background }, cwd };
    const ran = await $.process.run(["node", `${$.plugin.root}/skills/conductor/tools/hooks/decide.mjs`], {
      cwd,
      stdin: JSON.stringify(input),
      timeoutMs: 10_000,
    });
    const out = ran.exitCode === 0 && ran.stdout.trim() ? JSON.parse(ran.stdout) : {};
    if (typeof out.deny === "string") return { deny: out.deny };
    if (typeof out.command !== "string") return next(e);
    if (!(await autoApproved($, out.command))) return { deny: out.suggest };
    // The rewrite still goes through the permission chain beneath, as the command it now is.
    return next({ ...e, command: out.command });
  }).catch(($, e, next) => {
    // The queue must never block the work it schedules: on any failure the command runs as it was.
    $.ui.log("conductor: the queue check failed; the command ran unqueued", { to: "debug" });
    return next(e);
  });
};
