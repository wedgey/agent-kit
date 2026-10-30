# Binding: Claude Code

The only file that names models and tools. Read it once per session. During setup, also read `claude-code-setup.md`.

## Tiers

| Tier | Model | Effort | Escalates to |
|---|---|---|---|
| frontier | `opus` | `high` | `fable`, only when the operator asks |
| strong-code | `sonnet` | `medium` | `opus`, effort `high` |
| mechanical | `haiku` | `low` | `sonnet`, effort `medium` |
| bulk-read | `haiku` | `low` | `sonnet`, effort `low` |

The orchestrator runs on the session model.

Claude Code has one model family. Spawn reviewers and verifiers fresh at their own tier.

## Verbs

| Verb | Mechanism | Fallback |
|---|---|---|
| spawn | `Agent` tool with `prompt` (the brief), `description` and `subagent_type`. Add `model` and `effort` only to escalate or on the fallback path | None. Always available |
| fork | `Agent` with `subagent_type: "fork"`. Inherits the conversation, system prompt, model and prompt cache | If fork is unavailable, spawn with a full brief |
| continue | `SendMessage` to the delegate's id | Spawn fresh with the consolidated scope |
| ask | `AskUserQuestion` with options | In `-p` mode the tool is absent. Ask in plain text, list the options, and stop |
| track | The session's todo tool. Prefer a tool whose description says it holds the todo list the operator watches. Otherwise use a built-in todo or task tool. Pass the playbook's name as its title and the tracker issue's URL as its link where it takes them. Mark a skipped step with the tool's skipped status when it has one, else as completed with `skip: <reason>` in its text | If none exists, keep the list in the reply and restate it when it changes |
| show | Mermaid in the reply for flows. For a mockup, write a throwaway HTML file and publish it with the `Artifact` tool. Screenshots by path | Without `Artifact`, give the file path |
| background | The `Bash` tool with `run_in_background: true`. It notifies on completion. Do not poll | None. Run it in the foreground only when the queue has a free slot |
| hand over in place | `mcp__conductor__handover` as the turn's last call. See [Handing over in place](#handing-over-in-place) | epic.md step 9's fallback to a fresh session. Outside an epic, tell the operator in one line that a fresh session would be cheaper |
| isolate | `Agent` with `isolation: "worktree"` | Tell the delegate to `git worktree add` its own path and stay inside it |

## The queue on Bash

The plugin's mod queues a heavy `Bash` command as `node <plugin>/skills/conductor/tools/queue.mjs run --queue=<q> -- bash -c '<command>'`. It asks the session's permission check about the command as typed and about that queued form. When both are allowed outright (`bypassPermissions`, or rules that allow both), it rewrites the command in place, so type heavy commands plainly and pass `run_in_background: true`. When the typed command is denied, it goes on unchanged and is denied by its own rule. Otherwise the mod denies the call and names the queued form. Run exactly that, with `run_in_background: true`, and the person approves the real queued command. A queued form whose inner command a rule denies is denied too, so allowing `queue.mjs run` allows nothing a rule forbids. In every mode, a foreground heavy command on a full queue is denied with the holders named, so rerun it with `run_in_background: true`. A duplicate of a run already queued or running from the same folder is denied with that run's age and place. Wait for its notice when this session started it. A separate `PreToolUse` hook denies wait loops, so that check holds even where mods do not load.

## The context limit

The plugin's `PostToolUse` hook, `tools/hooks/context-guard.mjs`, reads a delegate's own transcript, or the session's, after each tool call. When the last turn's input passes `CONDUCTOR_CONTEXT_LIMIT` tokens (default 250000), it adds a note that tells the delegate to hand over. It speaks again at each further 50000. For the session's own agent, which has no `agent_id`, it reads the session's own `transcript_path` against `CONDUCTOR_SESSION_CONTEXT_LIMIT` (default 150000) and tells it to hand an epic over, or else to hand over in place when the stage in hand ends. `CONDUCTOR_HOOKS=off` turns it off. It remembers the last step it spoke at for each session and delegate, in `conductor-context-guard/` under the temp folder, and speaks on the first hooked call past that step. Claude Code runs no `PostToolUse` hook after a failed call or one a mod refused, so the call that crosses can be missed. On 2026-10-29 a coordinator crossed 150k on a failed MCP call and was never told. Observed on v2.1.312. A hook that runs in a delegate gets `agent_id`, and the delegate's transcript is `<session dir>/<session id>/subagents/agent-<agent_id>.jsonl`. The note reaches the delegate as a system reminder. Observed on v2.1.310, 2026-10-24.

## Handing over in place

hand over in place is `mcp__conductor__handover` with `keep` and `resume`. `keep` is what the session must still know: the epic's issue, each running lane's ticket, agent id, task id, branch and state, its watches' task ids, and the operator's standing instructions quoted. `resume` is the prompt that goes on, such as "Continue the epic from #431's latest hand-over comment". Any session that is not a lane uses it at the limit, epic or not. Outside an epic, `keep` holds the task and its issue, the playbook step, branch and PR, what is done and what is next, running delegates' ids, and the operator's instructions quoted, and `resume` names the next step. A session waiting on the operator hands over only once the answer has come, at the end of the stage that follows. The same hook runs on `UserPromptSubmit` and repeats the session's note on every prompt while its context is past the limit, because the note speaks once per step and a session that waited would otherwise not be told again. When that turn ends, the plugin's mod compacts the session with `keep` as the instructions and submits `resume`. The session is the same one, so its subagent lanes, background watches and `SendMessage` routes carry on. A turn that does not end with an answer cancels it, and the next turn must call it again. A second call while one is under way is refused. A compaction that is skipped or keeps failing shows a toast and submits nothing. The mod lives in `hooks/handover-mod.mjs`, registered through `queue-mod.mjs` because a plugin's `hooks.json` takes one module. Without the tool, the mod did not load, so hand over by the fallback in epic.md, or outside an epic tell the operator in one line that a fresh session would be cheaper. On 2026-10-29 a probe session compacted 9 s after its turn ended and a running subagent's notices still arrived afterwards. Observed on v2.1.312.

## Repo instruction files

Besides `AGENTS.md`, read `CLAUDE.md` and `.claude/skills/` in the repo.

## Spawning by role

Spawn each role as its role agent. The conductor plugin ships them from `claude-code-agents/`, and Claude Code scopes each name to the plugin. Each one carries its tier's model and effort, the tools its role may not use, its rules and the report shape, so the brief needs only GOAL, SCOPE, CONTEXT, ACCEPTANCE and GATE.

| Role | `subagent_type` | Default tier | Without the role agent |
|---|---|---|---|
| explorer | `conductor:explorer` | bulk-read | `Explore` |
| implementer | `conductor:implementer` | strong-code | `general-purpose` |
| editor | `conductor:editor` | mechanical | `general-purpose` |
| reviewer | `conductor:reviewer` | frontier | `general-purpose` |
| verifier | `conductor:verifier` | frontier | `general-purpose` |

To escalate, pass both `model` and `effort` from the tier table, and keep the spawn's `description` unchanged so the retry reads as the same piece of work. A per-spawn `model` replaces the agent's model, but the agent's `effort` stays unless you pass one.

If `subagent_type` is unknown, the plugin is not installed or not enabled in this session. Tell the operator to install it with `/plugin marketplace add wedgey/agent-kit` and `/plugin install conductor@agent-kit`, or to enable it with `/plugin enable conductor@agent-kit`, then run `/reload-plugins`. Meanwhile use the fallback type, pass `model` and `effort` on every spawn, and paste the body of `claude-code-agents/<role>.md` (everything below its frontmatter) into the brief.

The explorer, reviewer and verifier agents cannot edit or write files but can still run shell commands. After one of them, or any fallback spawn of those roles, returns, run `git status` and treat any change as a failed gate.

Every delegate that writes while another writes gets `isolation: "worktree"`. Disjoint paths in one tree still share the git index.

Delegates run in the background and notify on completion. Do not poll. Start the independent ones in one message so they run together.

## Lanes

A lane is a background subagent in its own worktree, spawned under the ticket's todo item so it groups there. It runs as long as the orchestrator's session does. Use a separate session (below) only when the epic must outlive this session, or the operator wants to take a lane over by hand.

| Verb | Mechanism |
|---|---|
| dispatch | `Agent` with `subagent_type: "general-purpose"`, `isolation: "worktree"`, the lane brief as `prompt`, and the lane's tier as `model` and `effort`. That is `sonnet` and `medium`, or `opus` and `high` for a ticket that needs design or an escalated lane. Set `description` to the ticket, such as `#562 lane`. Not a role agent, because a lane must spawn its own delegates and the role agents cannot. Spawn it while the ticket's item is the one most recently marked in progress |
| wait | A lane reports by ending its turn with the report as its text. Its completion notice carries it. A notice that says it is waiting on its own background work is interim, so keep waiting. A notice that carries one of the lane reports is the report, even while the lane's PR watcher still runs |
| continue | `SendMessage` to the lane's agent id. It arrives between the lane's tool calls, or wakes it when idle |
| stop | `TaskStop` with the lane's task id. A lane that is a subagent also stops when the session ends, which is why a handover compacts the session instead of ending it. Then `git worktree remove` its worktree once its branch is pushed |
| watch | `node <skill dir>/tools/watch-pr.mjs <pr>` through `Bash` with `run_in_background: true`. `<skill dir>` is the folder that holds conductor's `SKILL.md`. It asks `gh` about the PR, and about its base branch's own PR, every 60 seconds (`--interval`), and exits on the first change with one JSON line of events. It gives up after 12 hours (`--hours`). It costs no model turns while it waits, and its completion notice wakes the lane |
| watch lanes | `node <skill dir>/tools/watch-lanes.mjs <output file>` through `Bash` with `run_in_background: true`, one per lane. `<output file>` is the path the lane's dispatch result names, a link to its transcript. For a lane run as a separate session it is `~/.claude/projects/<cwd with / and . as ->/<sessionId>.jsonl`, both from `claude agents --json`. It looks every 60 seconds. When the file has not changed for 15 of its own minutes (`--quiet`), it reads the last entry and exits with one JSON line if the lane owes a reply to a tool result or message. A lane still inside a tool call counts only after three times as long, because healthy foreground calls ran 18 to 22 minutes. A lane that ended its turn is idle by design and never counts, and neither does one that handed its report back or that the operator interrupted. A gap of more than three intervals between looks, such as a sleeping machine, starts every count again. When two or more lanes stall in the same look it reports `box-slow` with their names instead, and every stall carries the box's one-minute load, cores and free memory. A transcript counts as gone once it vanishes, or when it has not appeared within the quiet limit. It gives up after 72 hours (`--hours`). stop the watch with `TaskStop` whenever its lane stops |
| read state | `git -C <worktree> status --short`, `git -C <worktree> log --oneline -3`, `gh pr view <branch>`, and the lane's last interim notice. Never read its transcript file yourself. The lane watch reads it so you do not |

The lane's worktree branches from `origin`'s default branch tip, not the local checkout. When BASE is a stacked parent, the lane runs `git fetch origin <parent>` and `git switch -c <BRANCH> origin/<parent>`, because the parent's own worktree still holds that branch. An escalated lane runs `git fetch origin <BRANCH>` and `git switch -c <BRANCH> origin/<BRANCH>`.

### When lanes must outlive this session

Dispatch a separate session instead, with `claude --bg --name <lane name> --permission-mode <your mode> --model <model> --effort <effort> "<lane brief>"`, with the lane's tier as above, from the repo's root, through the background verb. continue it with `SendMessage` to its name, read its state with `claude agents --json`, and stop it with `claude stop <id>`. Set the brief's REPORT TO to your session name so it can report by message. `ListAgents` prints your name on its first line. When you track the ticket, pass the lane's name in the todo tool's `lane` field so the pane can show it under the ticket. The pitfalls marked "separate sessions" apply only here.

## Pitfalls

- **A fresh worktree is bare.** A subagent's `isolation: "worktree"` fires none of the repo's own worktree hooks, so dependencies are not installed. Put the repo's documented setup command in the brief's SETUP line. The lane runs it in the background before its first check. Observed on v2.1.309, 2026-10-23.
- **A wrapped git is refused in a worktree lane.** The isolation guard refuses any `git` run behind another program, so a hook that rewrites commands, such as an output filter that prefixes them, leaves the lane unable to run git at all. Exclude git from such rewrites before the first epic. Observed on v2.1.309, 2026-10-23.
- **Separate sessions: share a permission class with them.** A message between a session that bypasses permission prompts and one that prompts is held until the operator approves it, and nobody sees that prompt in a background session. Always pass `--permission-mode` with your own mode, and run epics from `auto` or `bypassPermissions`. Observed on v2.1.309, 2026-10-23.
- **Separate sessions: they start on the dispatch folder's checkout.** They make their worktree only before their first edit, from whatever is checked out there, so BASE names `origin/<trunk>`. Observed on v2.1.309, 2026-10-23.
- **Separate sessions: untrusted folders refuse them.** `claude --bg` fails with "Workspace not trusted" in a folder no interactive session has trusted. Observed on v2.1.309, 2026-10-23.
- **Separate sessions: idle ones are reaped.** The supervisor stops a session that has sat idle and unattached for about an hour. A stopped session loses nothing, so resume it when its next instruction is ready. Per the agent view docs, read 2026-10-23.
- **Stall notices arrive late.** A delegate whose model stream stalls gets "Agent stalled: no progress for 600s", but four such notices on 2026-10-29 reached an idle orchestrator 114 to 447 minutes after the lane's last entry, each when the session woke for another reason. The lane watch exists for this. A continue resumes the stalled lane with its context. Observed on v2.1.312, 2026-10-29.
- **The advisor tool.** Every delegate's request carries a built-in `advisor` tool on `opus`, deferred so the delegate must find it by search. A delegate's search does not find it, an agent file cannot remove it, and no delegate has called it. A UI may show the advisor model and make routing look broken when it is not. Briefs say nothing about it. The doctor and the routing log still count its calls, because a call would be frontier spend outside the escalation rule. Observed on v2.1.308, 2026-10-22.
- **Silent override.** `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` makes every spawn ignore the requested `model` without a message. A per-spawn `model` beats plain `CLAUDE_CODE_SUBAGENT_MODEL`. Per the sub-agents docs, read 2026-10-17.
- **Fork locks the model.** A fork runs on the session model and takes no `model` or `effort`. It saves context, not cost.
- **Effort.** Per-spawn `effort` works on non-fork delegates. `CLAUDE_CODE_EFFORT_LEVEL` overrides it. Observed on v2.1.302, 2026-10-17.
- **Delegates cannot ask the operator.** `AskUserQuestion` is removed from every delegate. A brief must settle every decision, and a delegate that hits a question reports BLOCKED.
- **Fresh cache.** A non-fork delegate starts with an empty prompt cache and no conversation. The brief is all it has.
