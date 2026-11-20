# session-activity

A Claude Code pane beside the chat that shows what the session is doing. `/activity` opens or closes it.

- **Todo list.** The mod adds a `todos` tool the model writes its plan to. The pane draws its title, progress and current branch health, then the items in three groups: NOW (in progress), NEXT (pending, in order) and DONE (completed and skipped, folded to one line with a show button).
  - Each write sends the whole list, but an item it leaves out keeps its last status, so the list only grows. An item matches its earlier self by its text, else by its ticket when exactly one item on each side has it, so a renamed item keeps its start time and its `lane`. A write with a new `title`, or one sharing no item with a list whose items are all done or skipped, starts a new list.
  - The header reads `<done> of <total> done`. The total is fixed at the first write: an item added later counts apart, as `+2 found`. When the list was last written over 10 minutes ago the header adds `updated 12m ago`, as `⚠ stale` in the warning colour once an agent has ended since that write.
  - An agent sits under the item whose ticket leads its description (`#123 review`), else under the item in progress when it was spawned. A finished run of the same agent type and description under one item folds into the newer run, marked `run 2`; a run still going always shows.
  - A subagent may write its own list with the same tool. It shows as one line under the agent's row: `steps 1/3 · ◐ <in progress> · ○ <next>`.
  - When any item has a `lane`, only items with a ticket count toward the total. Items without one and agents under no item show last, under ORCHESTRATOR.
  - Every 5 minutes, up to 20 open items with a GitHub ticket are read with `gh api`. The reads run together, and past 20 each round starts where the last stopped. An issue closed as completed or a merged PR reads done, noted `closed on GitHub`; a PR closed unmerged or an issue closed as not planned does not. The stored list is not changed.
  - Each item's ticket sits in its own column, a link where one can be formed: the item's `ticket` field, or a leading `#123`, `owner/repo#123` or GitHub issue or PR URL in its text. A bare `#123` links into the repo of the list's `link` when that is an issue or PR, else of the branch's `origin`. A ticket URL off GitHub links under its last path segment.
  - A done item stays in view while an agent under it is running or ended badly (failed, `ISSUES`, `BLOCKED`, `FAIL`, or a read-only agent that changed the tree), and the DONE line counts them: `DONE · 3 · 1 ✗ · 1 running`.
  - Under 46 columns the NOW items and the first NEXT item stay in view, each ticket inline and cut to 6 columns; the rest of NEXT and the DONE line share one row.
  - An item whose ticket a background session (a lane, started with `claude --bg --name`) owns names it as `lane`. Its row shows the state of the newest background session of that name (working, blocked, failed, done, stopped, or `lane missing` when no session has that name). Expanded, it adds `lane <name> · <state> · waiting for <x> · <elapsed> · <done>/<total>` and up to two of the lane's in-progress items and its first pending one, read from the list the lane's own pane saved. Lanes are read with `claude agents --json --all` every 30 s, and every 15 s while the pane shows a lane item not yet done; a failed read keeps the last one, and a lane with no saved list shows no count. Under 46 columns only the state's glyph shows. Text read from another session has its control characters collapsed to spaces.
  - Each write is also kept in the mod's store under the session's id, so a resumed session that comes back in a new process gets its list back. Lists older than 7 days are pruned.
- **Agents.** Each subagent with its model, effort, elapsed time, tool calls and tokens. A row also shows:
  - the `STATUS` verdict of its newest report, handed back through `SubagentHandback` or given as its final answer; the row reads done once the run ends, even while the agent list still shows it running
  - a warning when it ran on another model or effort than its agent definition asks for
  - a warning when an agent whose definition forbids editing finished with new changes in the working tree
  - an escalation line when the same description was spawned again, on another model or effort, after an earlier run ended

Agent definitions are read from `<type>.md` in the project's `.claude/agents/` and in `~/.claude/agents/` (`$CLAUDE_CONFIG_DIR/agents/` when that is set). A plugin agent, `<plugin>:<name>`, is read from where the plugin is installed (`plugins/installed_plugins.json` in the same config folder): its `agents/` folder and each file or folder its `plugin.json` lists under `agents`, matched by the frontmatter `name`. Only `./` paths are read, and only files under 256 KB that stay inside the plugin's folder once symbolic links are followed. A copy of a plugin loaded with `--plugin-dir` is not seen, since a mod cannot list the folders of loaded plugins: an installed copy of the same name is read instead, if there is one. Files in subfolders of `.claude/agents/`, or named differently from their `name` there, get no routing check or read-only guard.
- **Servers and scripts.** Background commands with ports, CPU and memory, stop buttons and orphan cleanup. Ports are read every 10 s, so a new server's link can take that long to show.
- **Queue.** With agent-kit's conductor plugin installed (`conductor@agent-kit`, whose `skills/conductor/tools/queue.mjs` exists), the heavy-run queue its `queue.mjs` keeps: each queue's busy slots, the load against the cores and free memory, then each holder (place, command, time, CPU and memory, `idle` or `orphan` when so; a reading the tool could not take is left out, never shown as zero) with a stop button that asks first, offered while the holder's process is known, and stops only if the slot still holds the same process and command after the answer, and each waiter in rank order, `gate` runs tagged, with top, up and down buttons. A refused command shows the tool's reason, and a command that did nothing its note. Rows run from this session's process tree are marked `you`; another session in the same folder is not. A row run inside a subagent's worktree (`.claude/worktrees/agent-<id>`) is named by that agent's ticket and type, as `#849 lane`, or `other session` when the agent is not this session's, and the item the agent sits under shows `⧗ e2e slot · 1m11s` or `⧗ e2e waiting #2`. The section shows only while anything holds or waits. It is read every 30 s, and every 3 s while the pane shows and anything holds or waits. Sessions share that reading through the mod's store, so one session reads for the whole box: a session uses a reading young enough for its own interval, reads when none is and no other session has claimed the read in the last 15 s, and reads for itself when the store fails. A session on the 30 s interval can therefore show a reading up to about a minute old. A failed read holds its claim, so no session retries for 15 s. Opening the pane and pressing a button read fresh, unless a read is already running in that session; under 46 columns waiters are only counted.
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
