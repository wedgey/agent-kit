# Binding: Claude Code, setup

Read only during `/conductor:conductor setup`.

## The package

- Conductor's package is the `conductor` plugin in the `agent-kit` marketplace. Install it with `/plugin marketplace add wedgey/agent-kit`, then `/plugin install conductor@agent-kit`. `/plugin uninstall conductor@agent-kit` removes it.
- It ships the skill as `conductor:conductor`, the five role agents as `conductor:<role>`, a mod, `hooks/queue-mod.mjs`, whose `tool.call` hook on `Bash` queues heavy commands in place and denies wait loops (it asks `tools/hooks/decide.mjs` about any heavy or queued command), and a `SessionStart` hook that adds the pointer to every session's context. The hook reads the pointer from `setup.md` and writes `/conductor` as `/conductor:conductor`.
- It is installed and enabled when `claude plugin list --json` has an entry with `"id": "conductor@agent-kit"` and `"enabled": true`. A session started with `claude --plugin-dir <checkout>` loads it without an install and is not in that list. Then `conductor:conductor` among this session's skills is the proof.
- Disabled: `/plugin enable conductor@agent-kit`, then `/reload-plugins` or a new session.
- In headless `-p` mode, the doctor needs permission to run `claude plugin list` and read the files named below. Without it, say which check could not run.
- Suggest a slot count, and never write it. When `~/.claude/settings.json` has no `env.CONDUCTOR_QUEUE_SLOTS_TESTS`, suggest adding `CONDUCTOR_QUEUE_SLOTS_TESTS` = a quarter of `nproc`, at least 1, to that `env`. The hook and the queue both read it. Without it a queue runs one command at a time.

A repo that runs its own queue sets `"env": {"CONDUCTOR_QUEUE_MANAGED": "1"}` in its own `.claude/settings.json`. The hook reads that file in the repo a command runs in, and then only denies wait loops there. `CONDUCTOR_HOOKS=off` bypasses it. `CONDUCTOR_QUEUE_MIN_FREE_MB` (default 4096) is the free memory a second slot needs.

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

- **Hook.** Run `until true; do sleep 1; done` with the `Bash` tool. The registered hook must deny it with a reason that starts `Do not block the turn by sleeping or polling.` It cannot hang, because `until true` ends at once when nothing denies it. A leftover settings hook alone also passes this check, so the leftover check below is what tells the two apart.
- **Pointer.** This session's context must hold the pointer from the `SessionStart` hook. It begins `Conductor governs how you work in every repo.` and names `/conductor:conductor`.

## Leftovers of the old install

Before the plugin, setup wrote these files. Each one now doubles a piece the plugin ships. A second pointer names the old command, a second `conductor` skill loads beside `conductor:conductor`, unscoped copies of the role agents load beside the plugin's, and a second hook runs on every `Bash` call. List each one found, with its removal. Never remove one yourself.

| Leftover | Found when | Removal |
|---|---|---|
| Pointer block | The guard below prints exactly two lines | The command below |
| Role agents | Any of `~/.claude/agents/conductor-{editor,explorer,implementer,reviewer,verifier}.md` exists | `rm` each one that exists, by its full name. Leave any other file in that folder alone |
| Skill copy | `~/.claude/skills/conductor` exists | `rm -r ~/.claude/skills/conductor`. If it is a symlink, `rm ~/.claude/skills/conductor` removes only the link |
| Shared skill copy | `~/.agents/skills/conductor` exists. The old setup accepted it as an install location | Other harnesses may read this path. Remove it only when no harness on the machine uses it, with `rm -r ~/.agents/skills/conductor`, or `rm ~/.agents/skills/conductor` for a symlink |
| Settings hook | `~/.claude/settings.json` `hooks.PreToolUse` holds an inner hook object whose `command` contains `conductor/tools/hooks/pretooluse.mjs` | Remove each such object, and its matcher group only when that leaves the group's `hooks` empty. Touch nothing else. This command does it and rewrites the file with two-space indent: `node -e 'const fs=require("fs"),f=process.argv[1],m="conductor/tools/hooks/pretooluse.mjs",s=JSON.parse(fs.readFileSync(f,"utf8")),own=(h)=>String(h.command).includes(m);s.hooks.PreToolUse=s.hooks.PreToolUse.flatMap((g)=>g.hooks?.some(own)?(g.hooks=g.hooks.filter((h)=>!own(h))).length?[g]:[]:[g]);fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n")' ~/.claude/settings.json` |

**Pointer block.** First run this guard. It matches a marker line with any surrounding spaces and a trailing CR.

```
grep -nE '^[[:space:]]*<!-- conductor:(start|end) -->[[:space:]]*$' ~/.claude/CLAUDE.md
```

The block is a leftover only when the guard prints exactly two lines, a `start` line and then an `end` line. Then give this removal. It deletes both markers and the lines between, and keeps a symlinked file a symlink.

```
sed -i --follow-symlinks '/^[[:space:]]*<!-- conductor:start -->[[:space:]]*$/,/^[[:space:]]*<!-- conductor:end -->[[:space:]]*$/d' ~/.claude/CLAUDE.md
```

When the guard prints anything else, such as a lone marker, two blocks or `end` before `start`, give no command, because the range would delete to the end of the file. List the lines it printed and leave the edit to the operator.

After removing any of them, start a new session so the plugin's pieces are the only ones loaded.
