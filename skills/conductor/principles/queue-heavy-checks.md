# Queue heavy checks

**When:** Running tests, builds, typechecks or e2e, or spawning delegates that do.

**Why:** Every repo and lane on the box shares its cores. A heavy check that skips the queue slows everyone, and a lane parked on a full queue does nothing.

- Run heavy checks through the box queue. Use the repo's own wrapper if it has one. Else run `node <queue> run --queue=<tests|e2e> -- sh -c '<command>'`, where `<queue>` is `tools/queue.mjs` in this skill's folder.
- Leave out `--slots`. A queue runs one command at a time unless `CONDUCTOR_QUEUE_SLOTS_<QUEUE>` is set for the box, and the hook and the queue both read that. `node tools/hooks/defaults.mjs` in this skill's folder prints a suggested `CONDUCTOR_QUEUE_SLOTS_TESTS`.
- background the command and wait for its completion notice. Never sleep-poll.
- Never queue a watch mode. It never exits, so it would hold its slot forever.
- Never wrap a queued command in another lock. Holding one while waiting for the other deadlocks the lanes.
- Run `queue.mjs status` before you spawn delegates that verify. Run no more of them at once than the queue has slots.

The hook that `/conductor setup` installs denies a wait loop and an unqueued heavy command, and names what to run instead. A repo with its own queue marks itself managed, as the binding's setup file says, and the hook then only checks for wait loops.

**Example.** Three verifiers want the e2e suite and the queue has one slot. Spawn one, background its run, and spawn the next when its notice arrives.
