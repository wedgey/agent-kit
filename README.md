# agent-kit

Personal catalog of agent skills, plugins and related tooling. Each entry is installable on its own.

Design docs per entry: see [CONTEXT-MAP.md](./CONTEXT-MAP.md).

## Entries

- [`skills/conductor`](./skills/conductor/SKILL.md): the agent mode that sets how a coding agent plans, delegates and verifies, packaged as the `conductor` plugin. Work that needs one PR runs as a feature. Work that needs several PRs runs as an epic, with one lane per ticket. It also ships a box-wide queue for heavy checks, and Bash hooks that queue heavy commands and keep agents from waiting in loops.
- [`plugins/session-activity`](./plugins/session-activity/README.md): a Claude Code pane of the session's todo list, its subagents and lanes, background servers and the heavy-check queue.

## Add conductor to your codebase

### 1. Install the plugins

In Claude Code:

```
/plugin marketplace add wedgey/agent-kit
/plugin install conductor@agent-kit
/plugin install session-activity@agent-kit
/reload-plugins
```

Installing `conductor` gives the machine its skill, its five role agents (explorer, editor, implementer, reviewer, verifier), the queue and its hooks, and a start-of-task pointer that every session loads. `session-activity` adds the pane. Open it with `/activity`.

### 2. Check the install

Run `/conductor:conductor setup`. It spawns each role agent and reports the model and effort that actually ran, checks that the queue's hooks are live, and lists anything an older install left behind. It writes nothing. Remove what it lists yourself.

It also suggests a slot count. Set it once per machine in `~/.claude/settings.json`:

```json
{ "env": { "CONDUCTOR_QUEUE_SLOTS_TESTS": "2", "CONDUCTOR_QUEUE_SLOTS_E2E": "1" } }
```

A quarter of your cores is a good start for tests. Without a value each queue runs one command at a time. `CONDUCTOR_QUEUE_MIN_FREE_MB` (default 4096) is the free memory a second slot needs.

`CONDUCTOR_CONTEXT_LIMIT` (default 250000) is the context, in tokens, at which a lane hands over to a fresh lane. `CONDUCTOR_SESSION_CONTEXT_LIMIT` (default 150000) is the same for the session's own agent, at which an epic's orchestrator hands the epic over to a fresh session.

### 3. Prepare the repo

Conductor reads the repo's own rules first, and they win over its own. It works best when the repo has:

- **Agent instructions.** An `AGENTS.md` or `CLAUDE.md` with the commands to build, test, lint and typecheck, and the rules a change must meet.
- **An issue tracker it can reach.** Say which one in those instructions, for example GitHub Issues through `gh`. An epic keeps its tickets and graph there. Without one it keeps them in a file outside the repo.
- **A worktree setup command.** Lanes work in fresh git worktrees, and a fresh worktree has no dependencies installed. Document the one command that prepares one, such as `pnpm install` or a provisioning script, so each lane runs it first.
- **Its own queue, if it has one.** If the repo already gates heavy commands its own way, add `"env": { "CONDUCTOR_QUEUE_MANAGED": "1" }` to the repo's `.claude/settings.json`. Conductor's hooks then only stop wait loops there.

### 4. Use it

Ask for the work as you would any coding task. Conductor picks a playbook: investigation, bug fix, feature, refactoring, prototype, epic, opening a PR, babysitting one, or shipping. `/conductor:conductor` forces it on.

For a larger body of work, describe all of it or point at an epic issue. Conductor decides from the work whether it needs one PR or several. For several, it cuts tickets, draws their dependency graph, and dispatches one lane per ready ticket. Each lane writes its ticket's code, has it reviewed and verified by fresh agents, and carries its PR to merge-ready. Lanes run on Sonnet at medium effort, and on Opus at high effort when a ticket needs design or a lane escalates. Nothing merges until you ask for it to ship. Then each lane lands its own PR.

For epics:

- **Permission mode.** Run the session in `auto` or `bypassPermissions` mode, since nobody watches a lane's permission prompts.
- **Command-rewriting hooks.** If a hook of yours rewrites shell commands, for example an output filter that prefixes them, exclude `git` from it. The worktree guard refuses any git command that runs behind another program, and a lane needs git to commit.
- **Following progress.** In the pane, each ticket shows its lane, and the queue shows every heavy run on the machine.

### Uninstall

```
/plugin uninstall conductor@agent-kit
/plugin uninstall session-activity@agent-kit
```

## Develop

Conductor's tests need Node 24 and nothing else. Node does not expand a folder, so pass the glob in quotes.

```
node --test 'tests/conductor/*.test.mjs'
tests/conductor/mod-test.sh    # the Bash mod's hooks, tests/conductor/*.test.ts, under claude plugin test
CONDUCTOR_BANNED='<regex>' tools/check-conductor.sh
```
