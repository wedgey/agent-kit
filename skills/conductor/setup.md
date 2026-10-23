# Setup

What `/conductor setup` does. Follow these steps and nothing else.

Setup writes no files. Each harness gets conductor as one package whose install adds every piece and whose uninstall removes every piece. Setup checks that package and lists what an older install left behind.

1. **Detect the harness.** Find your own harness. Read `bindings/<harness>.md` and its setup file. With no binding, stop and say conductor has no binding for this harness.
2. **Confirm the package.** The binding's setup file names conductor's package for this harness and how to tell it is installed and enabled. If it is not, give the install steps and stop.
3. **Run the doctor.** Run the binding's doctor recipe. Keep its table and the lines below it.
4. **List leftovers.** The binding's setup file lists what an older install wrote outside the package. Check each one. For every leftover found, give its exact removal. Never remove one yourself. The operator decides.
5. **Reply.** Lead with whether routing works. Then give the doctor table and its lines, then the leftovers and their removals, or say there are none. Name every mismatch the doctor found and its likely cause.

Re-running setup changes no file.
