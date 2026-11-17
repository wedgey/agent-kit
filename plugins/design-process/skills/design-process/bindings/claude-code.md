# Binding: Claude Code

The only file in this skill that names models and tools. Read it once per session, before the first spawn.

## Roles

The plugin ships one agent per role from `claude-code-agents/`. Claude Code scopes each name to the plugin. Each agent carries its model, effort, the tools it may not use, its context rules and its report shape, so a brief needs only the goal, the paths to read, what to return and the gate.

| Role in SKILL.md | `subagent_type` | Model | Effort | Writes | Escalates to |
|---|---|---|---|---|---|
| Explorer | `design-process:explorer` | `haiku` | `low` | no | `sonnet`, `low` |
| Researcher | `design-process:researcher` | `sonnet` | `medium` | screenshots and its own picks file | `opus`, `medium` |
| Board drafter | `design-process:drafter` | `opus` | `medium` | its own `gen/<Prefix>.cjs` and boards | `opus`, `high` |
| Fixer | `design-process:fixer` | `sonnet` | `low` | the named boards | a fresh `design-process:drafter` with the canon |
| Senior reviewer | `design-process:reviewer` | `opus` | `high` | no | `fable`, `low`, only when the owner asks |
| Second reviewer | `design-process:second-reviewer` | `sonnet` | `medium` | no | `sonnet`, `high` |
| Ticket drafter | `design-process:ticket-drafter` | `sonnet` | `medium` | its issue files and crops | `opus`, `medium` |

The two reviewers run on different models on purpose. Never put both on the same one.

Never spawn `general-purpose` for a design role without the role's `model` and `effort` (see [Without the plugin](#without-the-plugin)). It inherits the session's model, so every researcher and drafter runs on the most expensive model with the largest context. In one landing-page project in November 2026, 140 of 141 delegates ran that way, read 3,093 screenshots between them, and grew to 250k to 290k tokens each.

The orchestrator stays on the session's model. Run the session on `opus`, not `opus[1m]`. The 1M window lets the orchestrator's own context grow far past the point where each turn gets expensive.

## Verbs

| Verb | Mechanism |
|---|---|
| spawn | `Agent` with `subagent_type` from the table, `description` and `prompt` (the brief). Add `model` and `effort` only to escalate |
| continue | `SendMessage` to the delegate's id. Fix passes go to the board's drafter this way, so it keeps the canon and its generator in context instead of reading them again |
| run in parallel | Start the independent spawns in one message. They run in the background and notify on completion. Do not poll |
| isolate | `isolation: "worktree"` when two delegates write in one repo. In the working folder, each drafter writes only its own `gen/<Prefix>.cjs` and its boards. You own `gen/skel.cjs`, the round's own boards and `canvas.json` |
| canvas | The claude.ai artifact server's tools: `mcp__claude-artifacts__guide`, `list_types`, `describe_type`, `create_from_type`, `list_files`, `read_file`, `upload_asset`, `get_artifact`, `edit_version`, and `publish_files` with `mode: "patch"` to publish. See `references/canvas.md` |
| ask | `AskUserQuestion` with options. In `-p` mode, ask in plain text, list the options, and stop |

A drafter's id stays valid for the session. It compacts itself near 120k tokens and then re-reads its brief and canon. When the drafter is gone (a new session, or its fix passes show it lost the canon), spawn `design-process:fixer` with the fix list and the boards it names.

The explorer and both reviewers cannot edit or write files, but they still have a shell. After one returns, run `git status` in any repo it could reach, and check the working folder for new files, and treat a change as a failed gate.

## Escalation

Pass both `model` and `effort` from the table and keep the spawn's `description`, so the retry reads as the same piece of work. A per-spawn `model` replaces the agent's model, but the agent's `effort` stays unless you pass one.

The senior reviewer moves to `fable` only when the owner asks for it. Per Anthropic's plan pages and Artificial Analysis's index, read 2026-11-17: on a Max plan `fable` draws on the weekly limit faster than `opus` and is capped at half of it, a Pro plan needs paid credits for it, and at `low` effort it scores about the same as `opus` at `high`, at a similar output cost.

## Without the plugin

If a `subagent_type` above is unknown, the plugin is not installed or not enabled. Tell the owner to run `/plugin marketplace add wedgey/agent-kit` and `/plugin install design-process@agent-kit`, or `/plugin enable design-process@agent-kit`, then `/reload-plugins`. Meanwhile spawn `general-purpose` with the role's `model` and `effort` from the table on every spawn, and paste the body of `claude-code-agents/<role>.md` (everything below its frontmatter) into the brief. Fallback spawns do not enforce the read-only roles.

## Checking the install

Spawn each role agent once, in one message, with no `model` or `effort` and the brief "Report the exact model name or ID in your system prompt, and stop." Then read what actually ran from the transcripts, not from the answers: in `<session dir>/<session id>/subagents/agent-<id>.jsonl`, each assistant line's `message.model` is the model and its `effort` field is the effort. Compare both with the table. A role that ran on the session's model means its agent file did not load. If `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` or `CLAUDE_CODE_EFFORT_LEVEL` is set (`printenv <name>`, never other values), it overrides every agent.
