// A lane compacts itself in place at the lane agent's autoCompactWindow. This hook tells the
// summarizer what a lane must keep, and puts a resume note after the summary, as the
// orchestrator's handover does with its keep and resume.
const LANE = "conductor:lane";

export const KEEP =
  "This is a conductor lane compacting in place to keep its turns cheap. It goes on working after the summary, so keep what it needs to continue, word for word where it names ids, paths, branches or SHAs: " +
  "every line of its lane brief whole (TICKET, BASE, BRANCH, PLAYBOOK, LAND, REPORT TO, SETUP, LANE, CONTEXT and any other); " +
  "its worktree path, its branch, its last pushed head, and any commits not yet pushed or edits not yet committed; its PR's URL; " +
  "the playbook step in hand and the next step; what is done; each decision with its reason; what is open; the files it touched; " +
  "the delegates, background commands, queue entries and watches still running, with their ids; and every message the orchestrator sent. " +
  "Drop file contents and tool output.";

export const RESUME =
  "Your context was compacted in place. You are the same conductor lane, in the same worktree, and the summary above holds your brief and your state. " +
  "Run git status and compare your branch with its pushed head, re-read only the sections of your reading list the next step needs, then continue from the next step. " +
  "Do not report Context full for this compaction.";

/** Whether the loop compacting is a lane. A failed lookup is not a lane, so the engine's own compaction runs. */
async function isLane($, agentId) {
  try {
    return (await $.agent.list()).some((a) => a.id === agentId && a.type === LANE);
  } catch {
    return false;
  }
}

/** @type {import('claude-code').Register} */
export const register = (on) => {
  on("session.compact", async ($, e, next) => {
    if (!e.agentId || !(await isLane($, e.agentId))) return next(e);
    const done = await next({ ...e, instructions: e.instructions ? `${KEEP}\n\n${e.instructions}` : KEEP });
    // A precompute result is kept and reused by the next compaction, so the note must not go on twice.
    if (!Array.isArray(done?.messages) || done.messages.at(-1)?.text === RESUME) return done;
    return { ...done, messages: [...done.messages, { role: "user", text: RESUME, toolUses: [] }] };
  });
};
