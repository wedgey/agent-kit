# Roles

Playbooks name roles. This table gives each role its tier. Your binding gives each tier a model.

| Role | Tier | Does | Gate that proves it |
|---|---|---|---|
| orchestrator | session model | Runs the playbook, writes briefs, owns verdicts | None. It is you |
| explorer | bulk-read | Reads files, logs, docs and history. Returns pointers, never conclusions | Every pointer resolves and every quote exists |
| implementer | strong-code | Writes code from a brief that leaves design choices open. Failing test first where the repo has a test harness | Tests and typecheck, then a reviewer |
| editor | mechanical | Applies a brief with nothing left to decide, or runs a command and reports the result | Lint, typecheck, tests, or a diff limited to the named files |
| reviewer | frontier | Reads a diff against the intent and the repo's standards, without running it | None. Judgment |
| verifier | frontier | Runs the change on the real artifact and reports pass or fail with evidence | None. Judgment |
| lane | strong-code, or frontier for a ticket that needs design | Runs one ticket's whole playbook, writing its code itself, to a merge-ready PR | Its own checks, then its reviewer and verifier, which run at their own tier |

## Tiers

- **frontier**: judgment no command can check. Design, review, verdicts.
- **strong-code**: code across function boundaries from a loose brief.
- **mechanical**: work the brief fully specifies.
- **bulk-read**: reading and condensing.

A role may run on mechanical or bulk-read only behind its gate, and the orchestrator reruns that gate before accepting the result. If a task has no gate, give it to a role on strong-code or above.

## Escalation

Each gate failure moves the same brief one tier up, with the failure pasted in. bulk-read and mechanical go up as the binding lists. strong-code goes to frontier. A failure at frontier, or a second failure on the same premise, comes back to you. Never rerun at the same tier.

## Diversity

A reviewer or verifier never wrote the code it judges, and is never forked. It runs on a different model family from the code's author when the binding offers one. With one family, a fresh delegate at the role's own tier is independent enough.

## The brief

A delegate cannot see this conversation. The brief is all it knows. Write it so a stranger could do the work.

```
GOAL        one sentence: the outcome
SCOPE       paths it may write, paths it may not, its isolated worktree if any
CONTEXT     file pointers and decisions it needs. Paste upstream results in full
ACCEPTANCE  checkable criteria, one per line
GATE        the exact command that proves it, and known traps
REPORT      the shape below
```

Size the brief to the work. A one-command job gets a paragraph that still names goal, scope, gate and report. Omit REPORT when your binding's role agent already carries the report shape. A brief that costs more than the work means do the work yourself.

## The report

Every delegate returns this and nothing else. Raw dumps stay out of your context.

```
STATUS     PASS | ISSUES | BLOCKED
DID        what it changed or read, as paths and commits
EVIDENCE   the gate's command and its result, quoted
FINDINGS   pointers (path:line) with one line each
OPEN       what it could not settle, and why
```

A verifier's STATUS carries its verdict instead: PASS, PASS+NOTES, FAIL or BLOCKED.

A delegate that can prove a problem reports ISSUES and lists every problem it can prove, not only the first.

## Lanes

A lane is the one delegate that runs a whole playbook. It owns one ticket from branch to merge-ready PR, in its own worktree, as its own orchestrator with its own delegates. Only the [epic](playbooks/epic.md) playbook dispatches lanes. It keeps its own context, can be steered while it works, and reports at fixed points, which is why a ticket gets a lane and not an implementer.

The lane brief replaces SCOPE and REPORT, and adds what an agent needs to work alone. Its first line tells the agent it is a lane, because a lane starts like any other agent and would otherwise follow the ordinary start of a task.

```
LANE        You are a lane. Load conductor, then read roles.md "Lanes" before anything else
TICKET      the ticket's URL, or the whole ticket when there is no tracker
PLAYBOOK    the playbook it runs: feature, bug-fix or refactoring
BASE        current origin/<trunk>, or the branch of the one merge-ready PR it stacks on
BRANCH      the branch to work on. An escalated lane names the branch its first lane pushed
SETUP       the repo's documented command that prepares a fresh worktree, if it has one
DESIGN      "needs design" when the epic flagged it, with what is still open. Otherwise "specified"
REPORT TO   only for a lane run as a separate session: the orchestrator's session name, to message
OWNS        paths it may write. Paths other lanes own, which it must not touch
CONTEXT     the graph's neighbours: what it needs and who needs it. Decisions already made
ACCEPTANCE  the ticket's acceptance, ending in its end-to-end check
```

A lane follows its playbook with these changes:

- **BASE wins.** It creates BRANCH from BASE, not from trunk, whatever the start of a task and opening-a-pr say. It fetches BASE from `origin` rather than checking out a branch another worktree holds. An escalated lane whose BRANCH already exists fetches it and continues from `origin/<BRANCH>`. It runs SETUP before its first check.
- **It writes the code.** A ticket is one dependent chain, so the lane implements it itself, per Delegation in SKILL.md. It spawns explorers for large reads, implementers only for parallel workstreams inside the ticket, and always a fresh reviewer and verifier.
- **Needs design means settle it.** With DESIGN set to needs design, it settles the open points itself and records them under the PR's Tradeoffs. It reports Blocked only for a product or preference call.
- **One ticket, one PR.** It never dispatches lanes. Work that would need a second PR is a Blocked report, not an epic.
- **Questions go up.** Every ask goes to the orchestrator as a Blocked report, after the lane has finished whatever the question does not touch. It never asks the operator directly.
- **It carries the PR to merge-ready.** The brief is the operator's request to babysit, so after opening-a-pr it runs [babysit](playbooks/babysit.md) in `drive` mode on its own PR, even when the PR sits above another in a stack. For a lane, merge-ready means checks green, no unresolved thread, and only approval and the merge left.
- **It never merges.** It owns its branch. A conflict or stale base found while babysitting is a Blocked report, not a rebase. A rebase the orchestrator asks for is the lane's to do, and that request allows a force-push with lease to its own branch, followed by a Head moved report.
- **It fails out loud.** A second FAIL from its verifier, or a second ISSUES from its reviewer on the same premise, is a Failed report.

It reports by ending its turn with the report, or by messaging REPORT TO when the brief sets it, and only at these points. Between them it keeps working. The orchestrator answers by message.

- **Merge-ready.** The PR's full URL, the reviewer's STATUS and the verifier's verdict in one line each, and what it left out.
- **Head moved.** After merge-ready, any push to its branch, with the new head, so lanes stacked on it can rebase.
- **Blocked.** The one question it cannot settle, with the options it sees.
- **Failed.** What it tried, the evidence, and what it would try next.

## Follow-ups

New work goes to a fresh delegate with consolidated scope: the original brief, every later instruction, and the prior report. **continue** a running delegate only when the work needs state that lives in it, such as uncommitted changes or a running server.

## Measuring routing (opt-in)

When the operator asks to measure routing, record one row per delegation: role, tier, model, rough tokens, gate result (passed, escalated, failed). The log's place and exact format are not settled yet. Until they are, keep the rows as a table in a file outside the repo's tree and give its path in the reply.
