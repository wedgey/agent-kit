# Encode lessons in structure

**When:** Writing the same rule a second time.

**Why:** A rule in prose depends on someone reading it. A rule built into the structure holds without anyone remembering.

The second time you write a rule into a brief, reply or comment is the signal to stop. Climb this ladder and stop at the first rung that works.

1. Make the mistake impossible. Change the type, the default or the API so the wrong thing cannot be written.
2. Add a check that fails the build, with an error message that names the fix. Use a type, a lint rule or a CI step.
3. Add a test that fails when the rule breaks.
4. Write the rule where it is read first, in the playbook step, the brief template or the repo's rules. Keep one copy. Add a reason only as SKILL.md "Instruction files" allows.

Fix the shape that let the mistake happen, not only the instance.

**Example.** Three briefs in a row remind a delegate to limit edits to named files. Make the gate a diff check on those files. The reminder is now unnecessary.
