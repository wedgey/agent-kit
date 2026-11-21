# Binding: Claude Code

The only file in this skill that names models and tools. Read it once per session, before the first spawn.

## Roles

The plugin ships one agent per role from `claude-code-agents/`. Claude Code scopes each name to the plugin. Each agent carries its model, effort, the only tools it may use, its context rules and its report shape, so a brief needs only the goal, the paths to read, what to return and the gate.

| Role in SKILL.md | `subagent_type` | Model | Effort | Writes | Escalates to |
|---|---|---|---|---|---|
| Explorer | `design-process:explorer` | `haiku` | `low` | no | `sonnet`, `low` |
| Researcher | `design-process:researcher` | `sonnet` | `medium` | screenshots and its own picks file | `opus`, `medium` |
| Board drafter | `design-process:drafter` | `sonnet` | `medium` | its own `gen/<Prefix>.cjs` and boards | `opus`, `high` |
| Fixer | `design-process:fixer` | `sonnet` | `low` | the named boards | a fresh `design-process:drafter` with the canon |
| Screenshot capturer | `design-process:screenshot-capturer` | `haiku` | `low` | shots, tiles, sheets and crops | `sonnet`, `low` |
| Senior reviewer | `design-process:reviewer` | `fable` | `low` | no | `fable`, `medium` |
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
| isolate | `isolation: "worktree"` when two delegates write in one repo. In the working folder, each drafter writes only its own `gen/<Prefix>.cjs` and its boards. You own `gen/skel.cjs` and `round.json` |
| answer page | The claude.ai artifact server's tools: `mcp__claude-artifacts__guide`, `publish_files` (`mode: "patch"` after the first publish), `declare_capabilities`, `get_artifact`, `list_files`, `read_file`, and `db_get`, `db_list` and `db_write` for the round's rows. See `references/answer-page.md` |
| watch | `mcp__design-process__answer_watch` with `{slug, round, screens}` after a round is published and marked open (`screens`: the thread numbers, or the screen count N for threads 1 to N). It polls every 10 s without model tokens and wakes the session with the new rows' paths. It stops when `rounds/<round>.status` is `"handled"`, after 6 h, or with `stop: true`, and on a stop other than handled it tells the session, which re-arms it or asks the owner. Write your thread rows with the id `<ISO time>-c` so they sort by time beside the owner's `<ISO>-<rand>` ids. Without the plugin's mod there is no tool: ask the owner to say in chat when they have sent |
| ask | Only where the answer page cannot run: in `-p` mode, or with no artifact server. Ask in plain text, list the options, and stop |

A drafter's id stays valid for the session. It compacts itself near 165k tokens (a 200k window) and then re-reads its brief and canon, and greps its generator rather than reading it whole. The plugin's mod (`hooks/compact-mod.mjs`) hooks `session.compact` for a drafter or fixer: it tells the summarizer to keep the brief's path, the generator's line ranges, the boards drawn and to draw, each fix list with what is applied, the last gate result and each board looked at with its verdict, and adds a resume note after the summary. Where the mod does not load, the agent still compacts at its window, without the keep or the note. When the drafter is gone (a new session, or its fix passes show it lost the canon), spawn `design-process:fixer` with the fix list and the boards it names.

The explorer and both reviewers cannot edit or write files, but they still have a shell. After one returns, run `git status` in any repo it could reach, and check the working folder for new files, and treat a change as a failed gate.

## Escalation

Pass both `model` and `effort` from the table and keep the spawn's `description`, so the retry reads as the same piece of work. A per-spawn `model` replaces the agent's model, but the agent's `effort` stays unless you pass one.

## Why the board drafter starts on `sonnet`

A drafter writes a generator from a canon and a brief, and the two reviewers score every board it draws, so a weak board is caught and goes back as a fix pass. Each drafter writes about 100k tokens, so the drafters are a large share of a round's cost, and `sonnet` costs less per token than `opus`. This is a trial from 2026-11-21. A drafter that needs more escalates to `opus` at `high`, as the table says. If most drafters in a round need that escalation, set the drafter's `model` back to `opus` in `claude-code-agents/drafter.md` and in the table.

## Why the senior reviewer runs on `fable`

Per Artificial Analysis's index and Anthropic's pricing, read 2026-11-17: `fable` at `low` scores 54, above `opus` at `high` (52), for about the same output cost. A review reads a few dozen tiles and writes a short report, so its higher input price matters little there. `fable` is kept off every role that writes boards or tickets. Those roles write about 100k tokens each and build large caches, which would cost about twice as much on `fable`.

On a Max plan, `fable` draws on the weekly limit faster than `opus` and is capped at half of it. A Pro plan needs paid credits for it. When `fable` is unavailable or its cap is reached, spawn the senior reviewer with `model: opus` and `effort: high`, and tell the owner in one line. The second reviewer stays on `sonnet`, so the two still differ.

## Without the plugin

If a `subagent_type` above is unknown, the plugin is not installed or not enabled. Tell the owner to run `/plugin marketplace add wedgey/agent-kit` and `/plugin install design-process@agent-kit`, or `/plugin enable design-process@agent-kit`, then `/reload-plugins`. Meanwhile spawn `general-purpose` with the role's `model` and `effort` from the table on every spawn, and paste the body of `claude-code-agents/<role>.md` (everything below its frontmatter) into the brief. Fallback spawns do not enforce the read-only roles.

## Checking the install

Spawn each role agent once, in one message, with no `model` or `effort` and the brief "Report the exact model name or ID in your system prompt, and stop." Then read what actually ran from the transcripts, not from the answers: in `<session dir>/<session id>/subagents/agent-<id>.jsonl`, each assistant line's `message.model` is the model and its `effort` field is the effort. Compare both with the table. A role that ran on the session's model means its agent file did not load. If `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` or `CLAUDE_CODE_EFFORT_LEVEL` is set (`printenv <name>`, never other values), it overrides every agent.
