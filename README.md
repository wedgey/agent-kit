# agent-kit

Personal catalog of agent skills, plugins and related tooling. Each entry is installable on its own.

Design docs per entry: see [CONTEXT-MAP.md](./CONTEXT-MAP.md).

## Entries

- [`skills/conductor`](./skills/conductor/SKILL.md): the agent mode that sets how a coding agent plans, delegates and verifies. `/conductor setup` installs it.
  It also ships a box-wide queue for heavy checks and a hook that keeps agents from waiting in loops.
- [`plugins/session-activity`](./plugins/session-activity/README.md): a Claude Code pane of the session's todo list, subagents and background servers.

Install a plugin from this catalog:

```
/plugin marketplace add wedgey/agent-kit
/plugin install session-activity@agent-kit
```
