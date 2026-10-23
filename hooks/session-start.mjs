#!/usr/bin/env node
// Conductor's SessionStart hook: the always-on pointer, as context for every session the plugin loads in.
const pointer = `Conductor governs how you work in every repo.
At the start of any coding task, load the conductor skill and follow its matched playbook.
The repo's own rules win where they conflict.
\`/conductor:conductor\` forces it on. \`/conductor:conductor setup\` re-runs setup.`;

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: pointer } }));
