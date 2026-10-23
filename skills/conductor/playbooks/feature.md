### Feature

**You own the design and the verdict.**

New or changed behaviour, built from a named data shape.

1. **Map the subsystem.** When it is too large to read in one pass, spawn explorers over it. They return pointers to the code, conventions and callers the change touches.
2. **Name the data shape.** Name it first, and the structure that holds it. Prefer a table over branching and a state machine over scattered booleans. Read [data-shape-first](../principles/data-shape-first.md). If the change crosses a function boundary, sketch 2 or 3 shapes and score them as SKILL.md "Choices get options" says. Show a diagram when the shape is a flow.
3. **Check what can run in parallel.** Write four todo items. A dimension that does not apply keeps its item, marked skipped with the reason.
   - Blocking first steps. What must land before anything can fan out.
   - Independent workstreams. Disjoint files, services or layers can run in parallel. Shared writes serialize.
   - Shared mutable state. Split the target rather than serialize, unless a real invariant forces it. Read [separate-before-sharing](../principles/separate-before-sharing.md).
   - Smallest safe decomposition. If one owner is best, say why. If it needs two or more PRs that ship on their own, stop and run [epic](epic.md) from its step 1 instead.
4. **Delegate by evidence.** One dependent chain stays with you. Spawn an implementer per independent workstream, each isolated, with files, the named data shape and acceptance in its brief. Spawn an editor for any exact mechanical edit, behind its gate.
5. **Build in small units.** Tests first where a harness exists. Build, check and commit one small unit at a time, per [sequence-verifiable-units](../principles/sequence-verifiable-units.md). A skipped test states its reason.
6. **Open the PR.** Run [opening-a-pr](opening-a-pr.md). It runs the reviewer and the verifier.

**Reply:** what you built and what changes for its users, the data shape and why, how you split the work in plain words, the options you scored, and open decisions, in the order and form of SKILL.md "Writing the reply".
