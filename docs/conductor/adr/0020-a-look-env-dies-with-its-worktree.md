# A look env dies with its worktree

A lane's quick-look recipe starts a dev server and a browser session and declares them in `<temp>/<worktree name>-look.env`, holding `PORT` and an `agent-browser --session <name>` line. Contexory's verify-web recipe, read 2026-11-21, writes exactly that, so the convention belongs to the recipe and the sweep only reads it.

The environment outlives its lane, because a lane that hits a usage limit or hands its context over never runs its cleanup. On 2026-11-21 a week of epics had left warm dev servers behind, each about 160 MB, and the leak was worse than the memory: the sweep counts a process whose working directory is inside the worktree as the worktree being in use, so a dead lane's server kept a 3 GB worktree that the sweep would otherwise have removed. The leak blocked the sweep.

So the sweep treats a declared look env as part of the worktree, not as a user of it. Processes of the env's own tree, found by walking parents from the port's listener while the working directory stays inside the worktree, do not keep a worktree in use. Everything else still does: a session's shell or editor in the worktree keeps it, and so does any process the declaration does not cover.

The removal, not the kill, decides. A worktree the sweep keeps for any reason keeps its server too, because a lane paused overnight on an open PR reuses the warm one. Only after `git worktree remove` succeeds does the sweep send the tree's topmost pid a SIGTERM, close the named browser session, and delete the declaration and its dev log. The pid comes from `ss`, is checked to run from inside the worktree before it counts, and is never matched by a command name, because a pattern cannot tell a lane's server from anything else on a shared box. Without `/proc` or `ss` the env step is skipped and the worktree counts as in use again, so nothing is killed blind.

A lane still cleans up on its own when it reports: the rule is in the lane role, because that is sooner and free. The sweep is the net for the lanes that cannot.
