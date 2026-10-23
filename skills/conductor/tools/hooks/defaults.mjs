#!/usr/bin/env node
/**
 * The slot count to set for each queue on this box. Neither the hook nor queue.mjs reads it.
 * Both resolve `--slots`, then `CONDUCTOR_QUEUE_SLOTS_<QUEUE>`, then 1. Run it to print the setting.
 */

import os from "node:os";

import { SLOTS_ENV_PREFIX, isDirectInvocation } from "../queue.mjs";

export function defaultSlots(queue, cores = os.availableParallelism()) {
  return queue === "tests" ? Math.max(1, Math.floor(cores / 4)) : 1;
}

/* c8 ignore next 3 -- process wiring */
if (isDirectInvocation(process.argv[1], import.meta.url)) {
  process.stdout.write(`${SLOTS_ENV_PREFIX}TESTS=${defaultSlots("tests")}\n`);
}
