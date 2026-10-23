# Binding: Claude Code, setup

Read only during `/conductor setup`.

## Setup data

- The user-level instruction file is `~/.claude/CLAUDE.md`. Create it if missing.
- In headless `-p` mode, setup needs permission to read the skill folder and write the files above. Without it, setup stops and writes nothing.
- The skill is discoverable from any repo when `SKILL.md` exists at `~/.claude/skills/conductor/` or `~/.agents/skills/conductor/`.
- Install every file in `claude-code-agents/` to `~/.claude/agents/`. A file that already matches stays. A file that differs is replaced. Leave every other file in that folder alone. New agents usually load into the running session within seconds, even when the folder was just created. Observed on v2.1.308, 2026-10-22.
- Install the PreToolUse hook into `~/.claude/settings.json`, created as `{}` if missing. Edit only `hooks.PreToolUse`.
  - The hook's path is the installed skill that step 2 found. When the skill is in both `~/.claude/skills/conductor/` and `~/.agents/skills/conductor/`, use `~/.claude`. When it is only in `~/.agents/skills/conductor/`, the object's `$HOME/.claude/...` becomes `$HOME/.agents/...`.
  - A conductor hook is an inner hook object `{type, command, timeout}` whose `command` contains `conductor/tools/hooks/pretooluse.mjs`. Match on "contains", because the command ends with a quote.
  - If the only conductor hook equals the object below, change nothing. Otherwise replace the first conductor hook with it and remove every other conductor hook.
  - Remove a matcher group only once removing conductor hooks has left its `hooks` list empty.
  - Append a new `{ "matcher": "Bash", "hooks": [<the object below>] }` group only when no conductor hook object exists in `hooks.PreToolUse`.
  - Never touch any other hook object, group or key.
  - Show the diff in the reply.

```json
{ "type": "command", "command": "node \"$HOME/.claude/skills/conductor/tools/hooks/pretooluse.mjs\"", "timeout": 5 }
```

- Suggest a slot count, and never write it. When `~/.claude/settings.json` has no `env.CONDUCTOR_QUEUE_SLOTS_TESTS`, suggest adding `CONDUCTOR_QUEUE_SLOTS_TESTS` = a quarter of `nproc`, at least 1, to that `env`. The hook and the queue both read it. Without it a queue runs one command at a time.

A repo that runs its own queue sets `"env": {"CONDUCTOR_QUEUE_MANAGED": "1"}` in its own `.claude/settings.json`. The hook reads that file in the repo a command runs in, and then only denies wait loops there. `CONDUCTOR_HOOKS=off` bypasses it.

## Doctor

Spawn each role agent once with no `model` or `effort`, so each runs on its own defaults. Add one `conductor-editor` probe with `model: sonnet` and `effort: medium` to prove escalation overrides the defaults. Spawn them all in one message. If a role agent is not found because it was just installed, stop and tell the operator to start a new session and run `/conductor setup` again. Install will find every file matching, and the doctor runs there. Use this brief.

```
GOAL: report which model you run on. Put the exact model name or ID stated in your system prompt on the DID line and report PASS. There is no gate and nothing to decide.
```

The reply is a claim. Confirm each probe from its files under `~/.claude/projects/<slug>/<session>/subagents/`. The slug is the workspace path with every character that is not a letter or digit replaced by `-`.

- `agent-<id>.meta.json` records the per-spawn `model` and `effort`. A default probe passes none, so its Requested value is the role's tier in the tier table.
- In `agent-<id>.jsonl`, each assistant line's `message.model` is the model that ran, and its `effort` field is the effort used.
- Count `advisor` tool calls in the `.jsonl`. They are frontier spend.

A model that ran but differs from the request is a silent fallback. An alias that comes back as a full ID of the same family and tier is a match. For a mismatch, check these in order and name the likely cause.

1. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` or `CLAUDE_CODE_EFFORT_LEVEL` is set. Read only these with `printenv <name>`. Never print other environment values.
2. A managed or admin setting pins models.
3. The requested model is not available on the account.

Output this table.

| Role agent | Tier | Requested | Ran | Effort | Match | Advisor calls |
|---|---|---|---|---|---|---|

Then check the hook.

- `~/.claude/settings.json` has exactly one conductor hook object, the file its command names exists, and its group's `matcher` matches `Bash`.
- Pipe `{"tool_name":"Bash","tool_input":{"command":"until grep -q x f; do sleep 20; done"}}` to `env -u CI node <installed skill>/tools/hooks/pretooluse.mjs`. It must print JSON with `"permissionDecision":"deny"`.

Report both on one `Hook:` line below the table, not as a row in it.
