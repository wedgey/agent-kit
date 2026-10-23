# agent-kit

Personal catalog of agent skills, plugins and related tooling. Each entry is installable on its own.

Design docs per entry: see [CONTEXT-MAP.md](./CONTEXT-MAP.md).

## Entries

- [`skills/conductor`](./skills/conductor/SKILL.md): the agent mode that sets how a coding agent plans, delegates and verifies, packaged as the `conductor` plugin.
  It also ships a box-wide queue for heavy checks, and a Bash hook that queues heavy commands in place and keeps agents from waiting in loops.
- [`plugins/session-activity`](./plugins/session-activity/README.md): a Claude Code pane of the session's todo list, subagents and background servers.

Install a plugin from this catalog:

```
/plugin marketplace add wedgey/agent-kit
/plugin install conductor@agent-kit
/plugin install session-activity@agent-kit
```

Installing `conductor` gives the machine its skill, its five role agents, the queue and its hooks, and the start-of-task pointer. `/conductor:conductor setup` then checks the install and lists anything an older install left behind. Uninstall removes all of it:

```
/plugin uninstall conductor@agent-kit
```

## Develop

Conductor's tests need Node 24 and nothing else. Node does not expand a folder, so pass the glob in quotes.

```
node --test 'tests/conductor/*.test.mjs'
claude plugin test .    # the Bash mod's hooks, tests/conductor/*.test.ts
CONDUCTOR_BANNED='<regex>' tools/check-conductor.sh
```
