const TOOL = "handover";
const CALLED_AS = `mcp__conductor__${TOOL}`;
// compact rejects while a turn runs. A lane notice queued at the turn's end starts another turn at
// once, so a handover that runs out of tries waits for the next main-loop turn end rather than dropping.
const RETRY_MS = 1_000;
const TRIES = 30;

const DESCRIPTION =
  "Hands this session over to itself: when your turn ends, the conversation is compacted to `keep` and `resume` is submitted as the next prompt. " +
  "Call it only when conductor's context note says your context passed the limit, at the end of the stage in hand, as the last call of your turn. Never while waiting on the operator, and never from a lane, which reports Context full instead. " +
  "First write anything that must outlive the summary to the tracker issue, or the PR body when there is none. Running lanes, delegates and watches keep running.";

const SCHEMA = {
  type: "object",
  properties: {
    keep: {
      type: "string",
      description: "What the compacted session must still know: the task and its issue, the playbook step, branch and PR, what is done and what is next, each running lane or delegate's ticket, agent id, task id and state, its watches' task ids, and the operator's standing instructions quoted",
    },
    resume: { type: "string", description: "The prompt that continues the work after the compaction, such as: Continue the epic from #431's latest hand-over comment." },
  },
  required: ["keep", "resume"],
};

// shortcut: a plugin reload between the tool call and the compaction drops the handover, and the
// context guard speaks again 50k later; move both into $.state if reloads mid-epic show up.
/** The handover the next main-loop turn end runs, or null. */
let pending = null;
/** Whether a handover is compacting or submitting now. */
let running = false;

const instructionsFor = (keep) =>
  `This session is handing over to itself to shrink its context. Keep only what follows, word for word where it names ids, and drop the rest of the conversation.\n\n${keep}`;

async function compactThenResume($, handover) {
  for (let tried = 1; ; tried++) {
    try {
      const done = await $.session.compact({ instructions: instructionsFor(handover.keep) });
      if (done?.skip) {
        $.ui.toast(`conductor: the handover's compaction was skipped (${done.skip}). Run /compact, then send: ${handover.resume}`);
        return;
      }
      break;
    } catch {
      if (tried >= TRIES) {
        pending ??= handover;
        return;
      }
      await $.clock.sleep(RETRY_MS);
    }
  }
  try {
    await $.prompt.submit({ text: handover.resume });
  } catch (error) {
    $.ui.log(`conductor: the handover could not submit its resume prompt: ${handover.resume}`, { to: "debug" });
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
    if (pending || running) return { result: "A handover is already under way. End your turn." };
    const keep = typeof e.keep === "string" ? e.keep.trim() : "";
    const resume = typeof e.resume === "string" ? e.resume.trim() : "";
    if (!keep || !resume) return { result: "Not handed over: give both keep and resume.", isError: true };
    pending = { keep, resume };
    return { result: "Handover queued. End your turn now with no further calls; the session compacts and continues with your resume prompt." };
  });

  on("turn.complete", async ($, e, next) => {
    const done = await next(e);
    if (e.agentId || !pending || running) return done;
    const handover = pending;
    pending = null;
    if (e.reason !== "answer") {
      $.ui.toast("conductor: the handover was cancelled because the turn did not end with an answer.");
      return done;
    }
    running = true;
    $.clock.after(0, () =>
      void compactThenResume($, handover)
        // Rejects only when the plugin has unloaded or its toast failed; nobody is left to tell.
        .catch(() => {})
        .finally(() => (running = false)),
    );
    return done;
  });
};
