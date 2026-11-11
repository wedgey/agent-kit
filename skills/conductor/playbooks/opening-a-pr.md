### Opening a PR

**You own getting a change in front of reviewers in a state they can judge.** Other playbooks end here.

Use `gh` only. No scripts. A reviewer and verifier that already ran on this head count. Do not rerun them.

1. **Confirm the branch.** The work should already sit on a branch off current `origin/<trunk>` (SKILL.md, start of every task). If it is on trunk or carries unrelated work, move it to a fresh branch or worktree before anything else, and rerun any review that ran on the old head. isolate any delegate that writes (see [separate-before-sharing](../principles/separate-before-sharing.md)).
2. **Make landable commits.** Each commit stands alone, in an order that tells the story. Amend a fix into the commit it belongs to. Make a new commit when the fix is separable. A commit body adds what the subject does not say.
3. **Review before the PR exists.** spawn a fresh reviewer on the branch, per roles.md Diversity. Give it the intent, the repo's standards and the diff, and fix what it proves. If behaviour changed, spawn a verifier once the reviewer's findings are fixed, to run the change on the real surface, at the tier roles.md Tiers gives it. One verdict then covers the head that goes up. See [prove-it-works](../principles/prove-it-works.md). Go on only when both come back clean.
4. **Write the title and body.** The repo's own PR and commit format wins, so look for a PR template, a contributing guide and recent merged PRs first. With none on record, use a Conventional Commits title, `type(scope): subject`, imperative, no trailing period. Write a one-minute briefing under `##` headings in this order, dropping any with nothing to say.
   - `## Why`, the problem and the approach, in one to three short sentences.
   - `## What changed`, one to three bullets. Name both sides of a rename.
   - `## Scope`, always. What it covers and what it leaves out.
   - `## Tradeoffs`, only for a real choice a reviewer would ask about.
   - `## Blast radius`, who or what it touches, and why that is safe or risky.
   - `## Verification`, each check you ran and its outcome, quoted from the run.

   After the sections, embed visuals that prove a claim, such as a screenshot of the changed screen or a recording of the flow. Link long logs and keep them out of the body.
5. **Create it ready.** Run `gh pr create --base <base> --title "<title>" --body-file <body.md>` without `--draft`. Prefer several narrow PRs to one wide one. In a stack, the bottom PR targets trunk and each child targets its parent's branch. Work independent of the stack branches from trunk.
6. **Read it back.** Run `gh pr view <pr> --json state,isDraft,baseRefName` before you state its status. If it opened as a draft, run `gh pr ready <pr>`.
7. **Post the URL.** Opening a PR never starts [babysit](babysit.md). Post the URL and keep building. Babysit when the operator asks.

**Reply:** the PR as a full URL, what the reviewer and the verifier each found in plain words, and what is left, such as the next PR in the stack, in the order and form of SKILL.md "Writing the reply".
