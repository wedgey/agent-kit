# Each design role is a defined agent with its own model

The plugin ships one agent per design role: explorer, researcher, drafter, fixer, reviewer, second reviewer and ticket drafter. Each carries its model, effort, the tools it may not use, its context rules and its report shape. Models are named only in `bindings/`.

A delegate spawned as a generic agent inherits the session's model and window. In one landing-page project in November 2026, 140 of 141 delegates ran that way on the most expensive model, read 3,093 screenshots between them, and grew to 250k to 290k tokens each. That one project used about 70% of a weekly limit. A role agent lands on its own model even when a spawn forgets to name one, and the read-only roles cannot edit. The two reviewers sit on different models by definition, which the skill's rule 9 asks for. The cost is that each role's rules live in SKILL.md and again in its agent file, and the two must be kept in step.

The drafter stays alive and takes its own fix passes, because it already holds the canon and its generator. A fresh fixer would read both again.
