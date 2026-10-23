# session-activity

A Claude Code pane beside the chat that shows what the session is doing. `/activity` opens or closes it.

- **Todo list.** The mod adds a `todos` tool the model writes its plan to. The pane draws its title, progress and current branch health, then the items in three groups: NOW (in progress), NEXT (pending, in order) and DONE (completed and skipped, folded to one line with a show button). Agents spawned while an item is in progress sit under that item.
  - Each item's ticket sits in its own column, a link where one can be formed: the item's `ticket` field, or a leading `#123`, `owner/repo#123` or GitHub issue or PR URL in its text. A bare `#123` links into the repo of the list's `link` when that is an issue or PR, else of the branch's `origin`. A ticket URL off GitHub links under its last path segment.
  - A done item stays in view while an agent under it is running or ended badly (failed, `ISSUES`, `BLOCKED`, `FAIL`, or a read-only agent that changed the tree), and the DONE line counts them: `DONE · 3 · 1 ✗ · 1 running`.
  - Under 46 columns the NOW items and the first NEXT item stay in view, each ticket inline and cut to 6 columns; the rest of NEXT and the DONE line share one row.
  - Each write is also kept in the mod's store under the session's id, so a resumed session that comes back in a new process gets its list back. Lists older than 7 days are pruned.
- **Agents.** Each subagent with its model, effort, elapsed time, tool calls and tokens. A row also shows:
  - the `STATUS` verdict of its newest report, handed back through `SubagentHandback` or given as its final answer; the row reads done once the run ends, even while the agent list still shows it running
  - a warning when it ran on another model or effort than its agent definition asks for
  - a warning when an agent whose definition forbids editing finished with new changes in the working tree
  - an escalation line when the same description was spawned again, on another model or effort, after an earlier run ended

Agent definitions are read from `<type>.md` in the project's `.claude/agents/` and in `~/.claude/agents/` (`$CLAUDE_CONFIG_DIR/agents/` when that is set). A plugin agent, `<plugin>:<name>`, is read from where the plugin is installed (`plugins/installed_plugins.json` in the same config folder): its `agents/` folder and each file or folder its `plugin.json` lists under `agents`, matched by the frontmatter `name`. Only `./` paths are read, and only files under 256 KB that stay inside the plugin's folder once symbolic links are followed. A copy of a plugin loaded with `--plugin-dir` is not seen, since a mod cannot list the folders of loaded plugins: an installed copy of the same name is read instead, if there is one. Files in subfolders of `.claude/agents/`, or named differently from their `name` there, get no routing check or read-only guard.
- **Servers and scripts.** Background commands with ports, CPU and memory, stop buttons and orphan cleanup.
- **Queue.** With the conductor plugin installed, the heavy-run queue its `queue.mjs` keeps: each queue's busy slots, the load against the cores and free memory, then each holder (place, command, time, CPU and memory, `idle` or `orphan` when so; a reading the tool could not take is left out, never shown as zero) with a stop button that asks first, offered while the holder's process is known, and each waiter in rank order, `gate` runs tagged, with top, up and down buttons. A refused command shows the tool's reason. Rows of this session are marked `you`. It is read every 30 s, and every 3 s while the pane shows and anything holds or waits; under 46 columns waiters are only counted.
- **Spend.** Tokens of every subagent turn, summed per model. Clearing finished rows keeps the totals.

The status line carries the todo progress, the running counts and, while anything holds or waits, `queue <busy>/<slots> +<waiting>`.

## Install

```
/plugin marketplace add wedgey/agent-kit
/plugin install session-activity@agent-kit
```

## Develop

```
claude plugin test plugins/session-activity
claude plugin validate plugins/session-activity
tsc -p plugins/session-activity
```

`tsc` needs the engine's types in `.claude-plugin/types/`, which the engine lays when it loads the mod from a folder you own (`claude --plugin-dir plugins/session-activity`).
