#!/usr/bin/env bash
# Usage: CONDUCTOR_BANNED=<regex> tools/check-conductor.sh [root]. Prints each violation and exits 1 if any.
set -u
root=${1:-$(git rev-parse --show-toplevel)}; fail=0
say() { echo "$1"; fail=1; }
# Words that must never appear in this repo come from the environment, so this file never names them.
if [ -n "${CONDUCTOR_BANNED:-}" ]; then
  while IFS= read -r hit; do say "banned word: $hit"; done < <(grep -rniwE "$CONDUCTOR_BANNED" "$root" --exclude-dir=.git)
fi
for skill in "$root"/skills/conductor*; do
  while IFS= read -r hit; do say "model/tool name outside bindings: $hit"; done < <(grep -rnwE 'opus|sonnet|haiku|fable|grok|gpt-[0-9.]+|gemini|claude-[a-z0-9-]+|CLAUDE\.md|AskUserQuestion|SendMessage|TodoWrite|subagent_type|run_in_background' "$skill" --include=*.md | grep -v "/bindings/")
  while IFS= read -r hit; do say "em dash: $hit"; done < <(grep -rn '—' "$skill")
  while IFS=: read -r file _ link; do
    target=${link#*](}; target=${target%%)*}; target=${target%%#*}
    case $target in http*|mailto:*|'') continue;; esac
    [ -e "$(dirname "$file")/$target" ] || say "broken link: $file -> $target"
  done < <(grep -rnoE '\]\([^)]+\)' "$skill" --include=*.md)
done
[ $fail = 0 ] && echo "check-conductor: clean"
exit $fail
