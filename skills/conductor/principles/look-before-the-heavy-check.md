# Look before the heavy check

**When:** iterating on a change a heavyweight checked-in check can verify — a spec, a build, a snapshot — or about to run one to see whether the change is right yet.

**Why:** the heavy check costs minutes and a shared queue slot; the direct observation costs seconds. One week of epics on one box ran about 2,000 spec commands against about 1,200 source edits, 84 s at the median and over five minutes on a loaded box, while a direct look at the running thing took about 4 s. Every one of those runs also queued every other delegate's checks, so the slow tail was self-inflicted.

Look first. Iterate with the cheapest observation that can answer the question in hand: look at the running thing, read its output, run the one targeted unit test. Run the heavyweight check once, to lock in what the iteration settled — never to discover it. A check whose failure would surprise you has not been looked at yet.

A bug fix inverts this: the failing check is the observation, so write it first and watch it go red, then iterate on the fix with the cheapest look that shows the symptom.

Where the repo offers no cheaper observation, the heavyweight check is the look, and the discipline is batching: group the edits, run it once per group, not once per edit.

A look never replaces the check. Whatever a look found that must stay fixed becomes an assertion in the checked-in check.
