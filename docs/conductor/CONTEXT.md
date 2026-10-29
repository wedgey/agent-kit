# Conductor

An agent mode: the standing reference for how a coding agent plans, delegates to cheaper models without losing quality, verifies, and reports, in any harness and with any provider.

## Work

**Operator**:
The person who directs the work and owns the calls conductor must not make alone: irreversible actions and product or preference choices.
_Avoid_: User (that is the product's end user), owner, human

**Playbook**:
The fixed sequence of steps conductor follows for one kind of task, ending in the reply that task owes.
_Avoid_: Workflow, recipe, procedure

**Orchestrator**:
The agent that runs the playbook, owns its verdicts, and writes the briefs. It runs on the session's model.
_Avoid_: Lead, main agent, parent, root

**Brief**:
The written handoff a fresh delegate starts from: goal, scope, context pointers, acceptance, gate and report shape.
_Avoid_: Prompt, task description, instructions

**Delegate**:
An agent the orchestrator spawns to do one scoped piece of a playbook step. A lane is the one delegate that runs a whole playbook.
_Avoid_: Subagent, worker, helper

**Work state**:
The plan, progress and pickup point of a piece of work: what is done, what is next, what is blocked.
_Avoid_: Status, todos, progress notes

**Tracker**:
The issue tracker a repo declares. When one is declared it holds the work state. The session's todo list holds the current playbook's steps and the todos found on the way, and links to the tracker's issue.
_Avoid_: Board, backlog, ticket system

**Epic**:
A body of work that needs two or more PRs that ship and verify on their own. Conductor judges it from the work, whether or not an epic issue exists.
_Avoid_: Project, initiative, milestone

**Ticket**:
One piece of an epic that ends in one PR, with the files it owns and acceptance that ends in an end-to-end check.
_Avoid_: Task, story, item, the queue's waiter file

**Lane**:
The one delegate that runs a whole playbook. It owns one ticket from branch to merge-ready PR, and to the merge when the operator asked to land it, in its own worktree, as its own orchestrator with its own delegates. The epic's orchestrator dispatches it and steers it by messages.
_Avoid_: Worker, sub-orchestrator, slot (that is the queue's)

## Shipping

**Stack**:
A chain of PRs where each PR's base is the branch of the PR below it, and the lowest one targets trunk.
_Avoid_: Train, chain, series

**Bottom PR**:
The lowest unmerged PR in a stack. Babysitting works only on it until it merges.
_Avoid_: Frontier (that is a tier), head PR, first PR

**Verdict**:
A verifier's PASS, PASS+NOTES or FAIL for one PR, tied to the commits it ran on and the base under them.
_Avoid_: Approval, sign-off, green

**Run**:
The contiguous verified PRs from the bottom of a stack up to the first PR without a passing verdict. Only a run lands.
_Avoid_: Batch, train

**Ceiling**:
The top PR of a run. Landing stops there.
_Avoid_: Tip, limit

## Routing

**Role**:
A job a delegate does inside a playbook, such as explorer, implementer or verifier. Playbooks name roles, never tiers or models.
_Avoid_: Persona, agent type

**Explorer**:
The role that reads on the orchestrator's behalf and returns pointers, never conclusions.
_Avoid_: Researcher, scout, searcher

**Implementer**:
The role that writes code from a brief that leaves design choices open.
_Avoid_: Coder, builder, developer

**Editor**:
The role that applies a brief with nothing left to decide, or runs a command and reports its result.
_Avoid_: Runner, fixer, mechanic

**Reviewer**:
The role that reads a diff against the intent and the repo's standards, without running it.
_Avoid_: Critic, auditor, judge

**Verifier**:
The role that runs a change on the real artifact and reports pass or fail with evidence. It never wrote the code.
_Avoid_: Tester, QA, checker

**Tier**:
A capability class a role defaults to: frontier, strong-code, mechanical or bulk-read.
_Avoid_: Level, size, budget

**Binding**:
The mapping, for one harness, from tiers to concrete models and efforts, and from conductor's abstract verbs to that harness's tools.
_Avoid_: Adapter, config, provider file

**Role agent**:
An agent definition a binding ships for one delegate role, carrying the role's default tier, the tools it may not use, its rules and the report shape.
_Avoid_: Tier agent, custom agent, subagent type

**Doctor**:
The check that spawns each role agent in a harness and confirms the model and effort that actually ran, so a silent fallback is caught.
_Avoid_: Health check, smoke test

## Queue

**Queue**:
A named, box-wide line that lets only a few heavy commands run at once, shared by every repo on the machine.
_Avoid_: Lock, semaphore, scheduler

**Slot**:
One place a queue can run a command. A queue has as many slots as its size.
_Avoid_: Lane, worker, permit

**Holder**:
The command that currently occupies a slot.
_Avoid_: Owner, runner

**Waiter**:
A command in a queue that has asked for a slot and has not got one yet.
_Avoid_: Pending job, blocked task

## Quality

**Gate**:
A mechanical check (test, typecheck, diff, exit code, schema) that can prove a delegate's output without judgment.
_Avoid_: Review, validation, guard

**Escalation**:
Re-running a delegate's failed work one tier up, with the gate's failure attached.
_Avoid_: Retry, fallback

**Principle**:
A rule of judgment conductor applies across playbooks, kept in its own file and read only when it applies.
_Avoid_: Guideline, best practice, value

## Configuration

**Package**:
The one installable unit that gives a harness conductor: the skill, its role agents, its hooks and the always-on pointer. Installing it adds every piece and uninstalling it removes every piece. For Claude Code it is a plugin.
_Avoid_: Bundle, distribution

**Setup**:
Conductor's own step that confirms the package is installed, runs the doctor, and lists what an older install left behind. It writes no files.
_Avoid_: Install, bootstrap, init

**Local overlay**:
An optional, per-machine file of rules conductor loads if present and never shares. It lives at one harness-neutral path.
_Avoid_: Local config, overrides, preferences
