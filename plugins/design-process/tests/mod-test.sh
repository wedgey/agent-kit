#!/usr/bin/env bash
# Runs the design-process mods' tests (tests/*.test.ts). `claude plugin test` collects every
# *.test.ts under the folder it is given and refuses a symlink out of it, so the hooks and the
# tests are copied into a folder of their own.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/.claude-plugin"
echo '{ "name": "design-process" }' > "$tmp/.claude-plugin/plugin.json"
cp -r "$root/hooks" "$tmp/"
cp "$root"/tests/*.test.ts "$tmp/"
claude plugin test "$tmp"
