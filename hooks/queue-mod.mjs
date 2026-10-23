// Conductor's queue on Bash calls. The command text is triaged here, in the module; only a heavy
// or queued command reaches Node, through decide.mjs, which reads the queue. Wait loops are left
// to the PreToolUse command hook, which holds even where mods do not load.
import { triage, typedQueued } from "../skills/conductor/tools/hooks/classify.mjs";

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

const typeTheCommand = (why, plain) =>
  `${why}. Type the plain command instead and run it in the background${plain ? `: ${plain}` : ""}; the queue wraps a heavy command itself.`;

/** A deny for a typed queued form whose body a rule denies, would prompt, or cannot be read; else null. */
async function checkTyped($, typed, outerVerdict) {
  if (typed.body === undefined) return { deny: typeTheCommand(`conductor cannot check what this queue.mjs run form runs: ${typed.error}`, typed.plain) };
  const v = await verdict($, typed.body);
  if (v?.decision === "deny") return { deny: `${v.reason ?? "A permission rule denies this command."} (${v.rule ?? "a deny rule"}, on the command inside queue.mjs run)` };
  // Only a prompt on the outer form shows the body to the person; anything else must allow the body itself.
  if ((await outerVerdict())?.decision !== "ask" && v?.decision !== "allow") {
    return { deny: typeTheCommand("The command inside queue.mjs run is not allowed on its own", typed.body) };
  }
  return null;
}

/** @type {import('claude-code').Register} */
export const register = (on) => {
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    if (e.command.trim() === PROBE) return { deny: "conductor's Bash mod is loaded." };
    let outer;
    const outerVerdict = () => (outer ??= verdict($, e.command));
    // Before any bypass: a rule allowing `node queue.mjs run` must not launder the body it runs.
    const typed = typedQueued(e.command);
    if (typed) {
      try {
        const denied = await checkTyped($, typed, outerVerdict);
        if (denied) return denied;
      } catch {
        return { deny: typeTheCommand("conductor could not check the command inside queue.mjs run") };
      }
    }
    const env = { CI: await $.env.get("CI"), CONDUCTOR_HOOKS: await $.env.get("CONDUCTOR_HOOKS") };
    const background = e.run_in_background === true;
    const first = triage(e.command, background, env);
    if (!first.host) return next(e);
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
    const original = await outerVerdict();
    if (original?.decision === "deny") return next(e);
    if (original?.decision !== "allow" || (await verdict($, out.command))?.decision !== "allow") return { deny: out.suggest };
    return next({ ...e, command: out.command });
  }).catch(($, e, next) => {
    // The queue must never block the work it schedules: on any failure the command runs as it was.
    $.ui.log("conductor: the queue check failed; the command ran unqueued", { to: "debug" });
    return next(e);
  });
};
