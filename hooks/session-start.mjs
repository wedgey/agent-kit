#!/usr/bin/env node
// Conductor's SessionStart hook: the always-on pointer from setup.md, as context for every session.
import { readFileSync } from "node:fs";

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

const additionalContext = pointer().replaceAll("`/conductor", "`/conductor:conductor");
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }));
