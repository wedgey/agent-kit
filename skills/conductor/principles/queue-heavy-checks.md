# Queue heavy checks

**When:** Running tests, builds, typechecks or e2e, or spawning delegates that do.

**Why:** Every repo and lane on the box shares its cores. A heavy check that skips the queue slows everyone, and a lane parked on a full queue does nothing.

- Run heavy checks through the box queue. Use the repo's own wrapper if it has one, else `skills/conductor/tools/queue.mjs run --queue=<tests|e2e> -- <command>`.
- background the command and wait for its completion notice. Never sleep-poll.
- Never wrap a queued command in another lock. Holding one while waiting for the other deadlocks the lanes.
- Run `queue.mjs status` before you spawn delegates that verify. Run no more of them at once than the queue has slots.
- After a test failure, rerun only the failed tests, once. A second failure is real.

The hook that `/conductor setup` installs denies a wait loop and an unqueued heavy command, and names what to run instead. A repo with its own queue sets `CONDUCTOR_QUEUE_MANAGED=1` so the hook only checks for wait loops.

**Example.** Three verifiers want the e2e suite and the queue has one slot. Spawn one, background its run, and spawn the next when its notice arrives.
