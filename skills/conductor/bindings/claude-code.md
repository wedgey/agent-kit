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

## The queue on Bash

The plugin's mod rewrites a heavy `Bash` command in place into `node <plugin>/skills/conductor/tools/queue.mjs run --queue=<q> -- bash -c '<command>'` before it runs, so type heavy commands plainly and pass `run_in_background: true`. The rewrite still goes through the permission rules, as the queued command. A foreground heavy command on a full queue is denied with the holders named: rerun it with `run_in_background: true`. A duplicate of a run already queued or running from the same folder is denied with that run's age and place: wait for its notice.
| isolate | `Agent` with `isolation: "worktree"` | Tell the delegate to `git worktree add` its own path and stay inside it |

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

## Pitfalls

- **The advisor tool.** Every delegate's request carries a built-in `advisor` tool on `opus`, deferred so the delegate must find it by search. A delegate's search does not find it, an agent file cannot remove it, and no delegate has called it. A UI may show the advisor model and make routing look broken when it is not. Briefs say nothing about it. The doctor and the routing log still count its calls, because a call would be frontier spend outside the escalation rule. Observed on v2.1.308, 2026-10-22.
- **Silent override.** `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` makes every spawn ignore the requested `model` without a message. A per-spawn `model` beats plain `CLAUDE_CODE_SUBAGENT_MODEL`. Per the sub-agents docs, read 2026-10-17.
- **Fork locks the model.** A fork runs on the session model and takes no `model` or `effort`. It saves context, not cost.
- **Effort.** Per-spawn `effort` works on non-fork delegates. `CLAUDE_CODE_EFFORT_LEVEL` overrides it. Observed on v2.1.302, 2026-10-17.
- **Delegates cannot ask the operator.** `AskUserQuestion` is removed from every delegate. A brief must settle every decision, and a delegate that hits a question reports BLOCKED.
- **Fresh cache.** A non-fork delegate starts with an empty prompt cache and no conversation. The brief is all it has.
