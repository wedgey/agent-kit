### Shipping

**You own what lands.** Verify each PR independently, land only the verified run from the bottom, then keep your hands off the stack.

Only an explicit operator request to land, ship or merge starts this playbook. In an epic, each lane runs it on its own PR under LAND, per roles.md "Lanes", and the orchestrator runs none of it. [Babysit](babysit.md) never does. The request authorises the merges below, and nothing beyond the PRs it names.

1. **Get a verdict on every PR.** spawn one verifier per PR, per roles.md Diversity. Verifiers that run servers in parallel get isolate. Brief each to run the change on the real surface the way a user would, comparing the PR's base branch against its head, and to post `PASS`, `PASS+NOTES` or `FAIL` with evidence on the PR. Green CI and a bot approval are not verdicts, because neither runs the change as a user would. See [prove-it-works](../principles/prove-it-works.md). Record the head SHA each verdict covers as `<verdict-sha>`, and the tip of `origin/<baseRefName>` it ran on as `<verdict-base>`.
2. **Find the run.** Walk up from the lowest unmerged PR and stop at the first one without `PASS` or `PASS+NOTES`. Everything below it is the run and the top PR is the ceiling. A verified PR above an unverified one waits, because it cannot land without the code beneath it. A PR that neither holds nor needs that code may move onto trunk and land alone, but it needs a fresh verdict first, because its old one ran with that code beneath it.
3. **Check each verdict still describes the code.** A rebase moves every PR above it to a new SHA without failing any check. Compare the PR's own commits, not only its tip.

   ```
   git range-diff <verdict-base>..<verdict-sha> <current-base>..<head-sha>
   ```

   `<current-base>` is the tip of `origin/<baseRefName>` now, and `<head-sha>` is the PR's head now. Identical commits mean the verdict stands. Commits shown as removed because a parent PR landed underneath are expected. Report any tests-only or docs-only difference and let it stand. Any other changed or added commit needs a fresh review and a fresh verdict, and the run now ends below that PR unless it comes back clean.
4. **Land bottom-up, one PR at a time.** Merge the lowest unmerged PR in the run, only after its checks pass, using the repo's merge method.

   ```
   gh pr merge <pr>
   gh pr view <pr> --json state,mergedAt,baseRefName
   ```

   Read the PR back. A merge command can succeed when a merge queue only queued the PR, and a requested auto-merge is not a merge. It landed only when `state` is `MERGED`, `mergedAt` is set and `baseRefName` is trunk. A PR whose base is still its parent's branch merged into that branch, not trunk, so stop and tell the operator. Use `--auto` only on a PR whose verdict covers its current head, because it lands whatever head is ready.
5. **Retarget the next PR.** After each merge, run `gh pr edit <next-pr> --base <trunk>`. Reapplying the next patch onto the merge result is a rebase, so the owner of that branch does it. If the retarget leaves the child conflicted or carrying the parent's commits, stop and report. Otherwise repeat step 3 for that PR before you merge it.
6. **Leave the stack alone.** The retarget in step 5 is the only change you make to a branch or base. A merge lands whatever its branch and base hold at that moment, verdict or not. If a merge stalls, find out why before you change anything.
7. **Stop at the ceiling.** Stop at the first unverified PR. Extending the run takes new verdicts, which is a new pass through step 1.

**Reply:** the verified run and its ceiling, each PR as a full URL with its verdict and which delegate gave it, what landed and how you confirmed it, and what the next gap needs before it can land, in the order and form of SKILL.md "Writing the reply".
