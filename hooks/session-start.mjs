#!/usr/bin/env node
// Conductor's SessionStart hook: the always-on pointer from setup.md, as context for every session.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The fallback must match setup.md's block; a test compares the two.
const BUILT_IN = `Conductor governs how you work in every repo.
At the start of any coding task, load the conductor skill and follow its matched playbook.
The repo's own rules win where they conflict.
\`/conductor\` forces it on. \`/conductor setup\` checks the install.`;

function pointer() {
  try {
    const setup = readFileSync(new URL("../skills/conductor/setup.md", import.meta.url), "utf8");
    const block = /^## The pointer\n[\s\S]*?^```\n([\s\S]*?)\n```$/m.exec(setup)?.[1];
    if (block?.startsWith("Conductor governs")) return block;
  } catch {}
  return BUILT_IN;
}

// Detached, because the hook has a 5-second budget and the sweep asks GitHub about every worktree.
if (process.env.CONDUCTOR_HOOKS !== "off" && !process.env.CI) {
  const sweep = fileURLToPath(new URL("../skills/conductor/tools/sweep-worktrees.mjs", import.meta.url));
  spawn(process.execPath, [sweep, "--background"], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

const additionalContext = pointer().replaceAll("`/conductor", "`/conductor:conductor");
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
