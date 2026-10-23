# Setup

What `/conductor setup` does. Follow these steps and nothing else.

Writing the operator's instruction file is reversible and is the whole purpose of setup. Proceed without asking. Show the diff in the reply.

1. **Detect the harness.** Find your own harness. Read `bindings/<harness>.md` and its setup file. With no binding, stop and say conductor has no binding for this harness, so nothing was written.
2. **Confirm the skill is discoverable.** The binding names where an installed skill must live to load from any repo. If conductor is not there, say how to install it and stop.
3. **Write the pointer.** The binding names the user-level instruction file. Check in this order.
   - The block between the markers already matches. Change nothing and say so.
   - Exactly one block exists and differs. Replace it.
   - No markers. Append the block after a blank line.
   - The file is missing. Create it with the block.
   - A lone marker or more than one block. Stop and show the operator the lines. Do not guess.
   - Never touch anything outside the markers.
4. **Install agent files.** Only if the binding lists them. Install any that are missing or differ. Skip ones that are already correct. If the binding lists none, say so.
5. **Install hooks.** Only if the binding lists them. Install any that are missing or differ, change no other entry, and show the diff. If the binding lists none, say so.
6. **Run the doctor.** Run the binding's doctor recipe. Keep its table.
7. **Reply.** Lead with whether routing works. Then list what was written, what was already correct, and the doctor table. Include the diff of the instruction file. Name every mismatch the doctor found and its likely cause.

## The pointer

Write exactly this block.

```
<!-- conductor:start -->
Conductor governs how you work in every repo.
At the start of any coding task, load the conductor skill and follow its matched playbook.
The repo's own rules win where they conflict.
`/conductor` forces it on. `/conductor setup` re-runs setup.
<!-- conductor:end -->
```

Re-running setup on a correct machine changes no file.
