#!/usr/bin/env bash
# Runs the Bash mod's tests (tests/conductor/*.test.ts) alone. `claude plugin test` collects every
# *.test.ts under the folder it is given, other plugins' included, and refuses a symlink out of it,
# so the mod and what it imports are copied into a folder of their own.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/.claude-plugin" "$tmp/skills/conductor/tools"
echo '{ "name": "conductor" }' > "$tmp/.claude-plugin/plugin.json"
cp -r "$root/hooks" "$tmp/"
cp -r "$root/skills/conductor/tools/hooks" "$tmp/skills/conductor/tools/"
cp "$root"/tests/conductor/*.test.ts "$tmp/"
claude plugin test "$tmp"
