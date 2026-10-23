# Binding: Claude Code, setup

Read only during `/conductor:conductor setup`.

## The package

- Conductor's package is the `conductor` plugin in the `agent-kit` marketplace. Install it with `/plugin marketplace add wedgey/agent-kit`, then `/plugin install conductor@agent-kit`. `/plugin uninstall conductor@agent-kit` removes it.
- It ships the skill as `conductor:conductor`, the five role agents as `conductor:<role>`, a `PreToolUse` hook on `Bash` that runs `tools/hooks/pretooluse.mjs`, and a `SessionStart` hook that adds the pointer to every session's context.
- It is installed and enabled when `claude plugin list --json` has an entry with `"id": "conductor@agent-kit"` and `"enabled": true`. A session started with `claude --plugin-dir <checkout>` loads it without an install and is not in that list. Then `conductor:conductor` among this session's skills is the proof.
- Disabled: `/plugin enable conductor@agent-kit`, then `/reload-plugins` or a new session.
- The plugin root is two levels above this skill's base directory. Its `hooks/session-start.mjs` prints the pointer.
- In headless `-p` mode, the doctor needs permission to run `claude plugin list` and read the files named below. Without it, say which check could not run.
- Suggest a slot count, and never write it. When `~/.claude/settings.json` has no `env.CONDUCTOR_QUEUE_SLOTS_TESTS`, suggest adding `CONDUCTOR_QUEUE_SLOTS_TESTS` = a quarter of `nproc`, at least 1, to that `env`. The hook and the queue both read it. Without it a queue runs one command at a time.

A repo that runs its own queue sets `"env": {"CONDUCTOR_QUEUE_MANAGED": "1"}` in its own `.claude/settings.json`. The hook reads that file in the repo a command runs in, and then only denies wait loops there. `CONDUCTOR_HOOKS=off` bypasses it.

## Doctor

Spawn each role agent by its scoped name, `conductor:<role>`, once with no `model` or `effort`, so each runs on its own defaults. Add one `conductor:editor` probe with `model: sonnet` and `effort: medium` to prove escalation overrides the defaults. Spawn them all in one message. If a role agent is not found, the plugin is not loaded in this session. Say so, give the enable steps above, and stop. Use this brief.

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

Then check the hook and the pointer, and report each on its own line below the table, `Hook:` and `Pointer:`, not as rows in it.

- **Hook.** Run `until true; do sleep 1; done` with the `Bash` tool. The registered hook must deny it with a reason that starts `Do not block the turn by sleeping or polling.` It cannot hang, because `until true` ends at once when nothing denies it. Then pipe `{"tool_name":"Bash","tool_input":{"command":"until grep -q x f; do sleep 20; done"}}` to `env -u CI node <skill base directory>/tools/hooks/pretooluse.mjs`. It must print JSON with `"permissionDecision":"deny"`.
- **Pointer.** This session's context must hold the pointer from the `SessionStart` hook. It begins `Conductor governs how you work in every repo.` and names `/conductor:conductor`. If it is missing while the plugin is loaded, run `node <plugin root>/hooks/session-start.mjs` and report what it prints.

## Leftovers of the old install

Before the plugin, setup wrote these files. Each one now doubles a piece the plugin ships. A second pointer names the old command, a second `conductor` skill loads beside `conductor:conductor`, unscoped copies of the role agents load beside the plugin's, and a second hook runs on every `Bash` call. List each one found, with its removal. Never remove one yourself.

| Leftover | Found when | Removal |
|---|---|---|
| Pointer block | `~/.claude/CLAUDE.md` has a `<!-- conductor:start -->` line | Delete the lines from `<!-- conductor:start -->` through `<!-- conductor:end -->`, both markers included, and nothing else. With GNU sed: `sed -i '/^<!-- conductor:start -->$/,/^<!-- conductor:end -->$/d' ~/.claude/CLAUDE.md` |
| Role agents | `ls ~/.claude/agents/conductor-*.md` lists files | `rm` each file it lists, for example `rm ~/.claude/agents/conductor-*.md` |
| Skill copy | `~/.claude/skills/conductor` exists | `rm -r ~/.claude/skills/conductor`. If it is a symlink, `rm ~/.claude/skills/conductor` removes only the link |
| Settings hook | `~/.claude/settings.json` `hooks.PreToolUse` holds an inner hook object whose `command` contains `conductor/tools/hooks/pretooluse.mjs` | Remove each such object, and its matcher group only when that leaves the group's `hooks` empty. Touch nothing else. This command does it and rewrites the file with two-space indent: `node -e 'const fs=require("fs"),f=process.argv[1],m="conductor/tools/hooks/pretooluse.mjs",s=JSON.parse(fs.readFileSync(f,"utf8")),own=(h)=>String(h.command).includes(m);s.hooks.PreToolUse=s.hooks.PreToolUse.flatMap((g)=>g.hooks?.some(own)?(g.hooks=g.hooks.filter((h)=>!own(h))).length?[g]:[]:[g]);fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n")' ~/.claude/settings.json` |

After removing any of them, start a new session so the plugin's pieces are the only ones loaded.
