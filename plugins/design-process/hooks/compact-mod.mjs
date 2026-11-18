// A drafter or fixer compacts itself at its agent file's autoCompactWindow. This hook tells the
// summarizer what it must keep, and puts a resume note after the summary, so it does not re-read
// its whole generator and every board after each compaction.
const ROLES = new Set(["design-process:drafter", "design-process:fixer"]);

export const KEEP =
  "This is a design-process board drafter or fixer compacting in place. It goes on working after the summary, so keep what it needs to continue, word for word where it names paths, prefixes, board names, line numbers or commands: " +
  "its brief file's path and every instruction from the brief or the orchestrator still in force; its prefix, its generator file's path, and the line ranges of each board or helper it has written or edited; " +
  "the boards drawn and the boards still to draw; each fix pass's numbered list, with which items are applied and which are not; " +
  "the last gate result quoted (the colour asserts and render.cjs's overflow lines); every board image it has looked at, with its verdict (fine, or what is wrong); " +
  "the step in hand and the next step; each decision with its reason; and what is open. " +
  "Drop file contents, image contents and tool output.";

export const RESUME =
  "Your context was compacted in place. You are the same drafter or fixer, and the summary above holds your brief's path and your state. " +
  "Re-read only the brief sections the next step needs. Do not read your generator whole: grep -n for what the next step touches and Read that range. " +
  "Do not look again at a board the summary marks fine unless you changed it since. Then continue from the next step.";

/** Whether the loop compacting is a drafter or fixer. A failed lookup is neither, so the engine's own compaction runs. */
async function isBoardWriter($, agentId) {
  try {
    return (await $.agent.list()).some((a) => a.id === agentId && ROLES.has(a.type));
  } catch {
    return false;
  }
}

/** @type {import('claude-code').Register} */
export const register = (on) => {
  on("session.compact", async ($, e, next) => {
    if (!e.agentId || !(await isBoardWriter($, e.agentId))) return next(e);
    const done = await next({ ...e, instructions: e.instructions ? `${KEEP}\n\n${e.instructions}` : KEEP });
    // A precompute result is kept and reused by the next compaction, so the note must not go on twice.
    if (!Array.isArray(done?.messages) || done.messages.at(-1)?.text === RESUME) return done;
    return { ...done, messages: [...done.messages, { role: "user", text: RESUME, toolUses: [] }] };
  });
};
