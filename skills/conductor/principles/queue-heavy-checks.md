# Queue heavy checks

**When:** Running tests, builds, typechecks or e2e, or spawning delegates that do.

**Why:** Every repo and lane on the box shares its cores. A heavy check that skips the queue slows everyone, and a lane parked on a full queue does nothing.

- Run heavy checks through the box queue. Use the repo's own wrapper if it has one. Else run `node <queue> run --queue=<tests|e2e> -- bash -c '<command>'`, where `<queue>` is `tools/queue.mjs` in this skill's folder.
- Leave out `--slots`. The hook and the queue both read the slot count from `CONDUCTOR_QUEUE_SLOTS_<QUEUE>` for the box.
- **background** the command and wait for its completion notice. Never sleep-poll.
- Never queue a watch mode. It never exits, so it would hold its slot forever.
- Never wrap a queued command in another lock. Holding one while waiting for the other deadlocks the lanes.
- Before you spawn delegates that verify, count the queue's slots. They are `CONDUCTOR_QUEUE_SLOTS_<QUEUE>`, or 1 when it is unset. `queue.mjs status` shows nothing on a fresh box. Run no more of them at once than that.

The hook that `/conductor setup` installs denies a wait loop and an unqueued heavy command, and names what to run instead. A repo with its own queue marks itself managed, as the binding's setup file says, and the hook then only checks for wait loops.

**Example.** Three verifiers want the e2e suite and the queue has one slot. Spawn one, background its run, and spawn the next when its notice arrives.
