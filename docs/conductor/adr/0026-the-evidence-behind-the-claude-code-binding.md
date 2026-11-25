# The evidence behind the Claude Code binding

ADR 0025 says instruction files hold only what to do. This change moves the dates, versions, probes and measurements out of the Claude Code binding and the look-before-the-heavy-check principle. Each rule stays in its file. Its evidence is recorded here, grouped by the binding section it supports.

## Usage-limit cuts

- No channel reaches a stopped session from outside it. See ADR 0021.
- Usage-limit cut-offs end each running delegate's turn with a notice that names the reset time, and its context and worktree stay. Observed 2026-11-10, when 24 agents were cut off in two windows.

## The context limit

- design-process's drafter and fixer set a 200000 window on purpose. On 2026-11-18 to 20 the guard, then holding them to the delegate limit, sent them 50 notes to end their turn at about 138k.
- On 2026-11-10 an epic's delegates of every role ran to 230k to 323k tokens under the old 250000 default.
- Claude Code runs no `PostToolUse` hook after a failed call. On 2026-10-29 a coordinator crossed 150k on a failed MCP call and was never told. Observed on v2.1.312.
- A hook in a delegate gets `agent_id`, the transcript path follows from it, and the note arrives as a system reminder. Observed on v2.1.310, 2026-10-24.

## A lane compacts in place

- Claude Code compacts about 33k below the window. A 120000 window compacted lanes at a median 88k across 1,253 compactions, and a 200000 window compacted drafters at 168k. Compactions spread about 9k above that median. So the window is at most the guard's 120k, plus the 33k gap, less 13k for the spread, which is 140k. See ADR 0022.
- A probe on v2.1.322, 2026-11-11, gave an agent a 100k window. It compacted 8 times mid-turn, its turns peaked at 79k, the keep held a codeword through all 8 summaries, and it finished its task.
- A second probe the same day spawned the plugin's `conductor:lane` on `sonnet` from the agent file. It compacted 6 times at 85k to 90k, the resume note followed each summary, and it read all 45 files it was given.

## Handing over in place

- Both context notes name the handover tool. On 2026-10-30 two sessions given a note that only pointed to the binding did not hand over.
- On 2026-10-29 a probe session compacted 9 s after its turn ended, and a running subagent's notices still arrived afterwards. Observed on v2.1.312.

## Spawning by role

- On 2026-11-21 a `haiku` delegate started at 36.0k input tokens with a deny list and 16.8k with the reviewer's tool list. The 16.8k was measured in `-p` mode, where `Artifact` is absent, so an interactive explorer or reviewer pays a few thousand more. Explorers read artifacts 19 times in 25 runs, so they keep it.
- `Skill` alone costs about 11k tokens a turn.
- `Explore` sees the session's MCP servers. Observed on v2.1.330.
- On 2026-11-23, 41 reviews on `opus` were 10% of a day's spend, $40.50 of $421 at API prices. The same tokens on `sonnet` cost half, at $2/$10 against $4/$20 per million. See ADR 0023.
- On 2026-11-10, verifiers on `opus` were the largest cost of an epic's five-hour window, at 22%, while most of them only ran a named spec and compared screenshots.

## Lanes

- On 2026-11-10 an orchestrator dispatched 11 of 27 `general-purpose` lanes on `opus`, 9 of them with no effort, and they cost 29% of the window.
- A probe on v2.1.322, 2026-11-11, ran a plugin agent that spawned `conductor:explorer` and returned its reply, at depth 2.

## Cleaning up worktrees

- Claude Code's own worktree cleanup, per its worktrees docs, read 2026-11-06. A lane's worktree is often over 3 GB once SETUP has run. On 2026-11-06 this box held 7 agent worktrees and 34 `worktree-agent-*` branches.

## Pitfalls

- A fresh worktree is bare, a wrapped git is refused in a worktree lane, and separate sessions need a shared permission class, start on the dispatch folder's checkout and are refused in untrusted folders. All observed on v2.1.309, 2026-10-23.
- Idle separate sessions are reaped after about an hour, per the agent view docs, read 2026-10-23.
- On 2026-11-19 a lane ran an e2e in the background and ended its turn with "waiting for its result". The e2e passed 32 minutes before the operator asked whether the epic had stalled. The lane never resumed, and the watch printed nothing because a finished turn never counted then.
- Four "Agent stalled" notices on 2026-10-29 reached an idle orchestrator 114 to 447 minutes after the lane's last entry, each when the session woke for another reason. Observed on v2.1.312. See ADR 0014.
- The `advisor` tool in delegates. Observed on v2.1.308, 2026-10-22. See ADR 0024.
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, per the sub-agents docs, read 2026-10-17.
- Per-spawn `effort`. Observed on v2.1.302, 2026-10-17.

## Look before the heavy check

One week of epics on one box ran about 2,000 spec commands against about 1,200 source edits. A spec took 84 s at the median and over five minutes on a loaded box, while a direct look at the running thing took about 4 s. Every one of those runs also queued every other delegate's checks, so the slow tail was self-inflicted.
