// Conductor's in-place handover. The orchestrator calls the handover tool once an epic's state is on
// its issue; when that turn ends, the session compacts to what must survive and goes on by itself.
// The session never ends, so its subagent lanes and background watches keep running through it.

export const TOOL = "handover";
const CALLED_AS = `mcp__conductor__${TOOL}`;
// compact rejects while a turn runs, and turn.complete fires before the engine counts the turn over.
export const RETRY_MS = 1_000;
export const TRIES = 30;

const DESCRIPTION =
  "Hands this session over to itself: when your turn ends, the conversation is compacted to `keep` and `resume` is submitted as the next prompt. " +
  "Call it only after the epic's state is written to its issue, as the last call of your turn. Running lanes and watches keep running.";

const SCHEMA = {
  type: "object",
  properties: {
    keep: {
      type: "string",
      description: "What the compacted session must still know: the epic's issue, each running lane's ticket, agent id, task id, branch and state, its watches' task ids, and the operator's standing instructions quoted",
    },
    resume: { type: "string", description: "The prompt that continues the work after the compaction, such as: Continue the epic from #431's latest hand-over comment." },
  },
  required: ["keep", "resume"],
};

/** The handover the next main-loop turn end runs, or null. One per session. */
let pending = null;

const instructionsFor = (keep) =>
  `This session is handing over to itself to shrink its context. Keep only what follows, word for word where it names ids, and drop the rest of the conversation.\n\n${keep}`;

async function compactThenResume($, handover) {
  for (let tried = 1; ; tried++) {
    try {
      const done = await $.session.compact({ instructions: instructionsFor(handover.keep) });
      if (done?.skip) {
        $.ui.toast(`conductor: the handover's compaction was skipped (${done.skip}). Run /compact, then continue the epic.`);
        return;
      }
      break;
    } catch (error) {
      if (tried >= TRIES) {
        $.ui.toast(`conductor: the handover could not compact (${error?.message ?? error}). Run /compact, then continue the epic.`);
        return;
      }
      await $.clock.sleep(RETRY_MS);
    }
  }
  try {
    await $.prompt.submit({ text: handover.resume });
  } catch (error) {
    $.ui.toast(`conductor: the session compacted but could not continue (${error?.message ?? error}). Send: ${handover.resume}`);
  }
}

/** @type {import('claude-code').Register} */
export const register = (on) => {
  on("session.start", async ($, e, next) => {
    try {
      await $.tool.register({ name: TOOL, description: DESCRIPTION, inputSchema: SCHEMA, isDeferred: false });
    } catch {}
    return next(e);
  });

  on("tool.call", { tool: CALLED_AS }, async (_$, e) => {
    if (e.agentId) return { result: "Not handed over: only the session's own agent hands over. A lane reports Context full instead.", isError: true };
    const keep = typeof e.keep === "string" ? e.keep.trim() : "";
    const resume = typeof e.resume === "string" ? e.resume.trim() : "";
    if (!keep || !resume) return { result: "Not handed over: give both keep and resume.", isError: true };
    pending = { keep, resume };
    return { result: "Handover queued. End your turn now with no further calls; the session compacts and continues with your resume prompt." };
  });

  on("turn.complete", async ($, e, next) => {
    const done = await next(e);
    if (e.agentId || !pending) return done;
    const handover = pending;
    pending = null;
    // An interrupted turn means the operator stepped in, so the handover waits for them.
    if (e.reason !== "answer") {
      $.ui.toast("conductor: the handover was cancelled because the turn did not finish.");
      return done;
    }
    // Rejects only once the plugin has unloaded, when nobody is left to tell.
    $.clock.after(0, () => void compactThenResume($, handover).catch(() => {}));
    return done;
  });
};
