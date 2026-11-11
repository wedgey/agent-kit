---
status: limit amended to 120k by ADR 0017
---

# A lane hands over at a context limit

Every turn of an agent re-reads its whole context, so a turn costs more as the context grows. On 2026-10-24 we measured 25 lanes from three epics, which used 2,072M tokens. About 95% of those tokens were cache reads. The second half of each lane's turns used 65% of its tokens, and lanes ended with 300k to 875k tokens of context. None of them compacted. The lanes' own edit loop (an edit, then a read of the same code again) used 56% of the tokens, and a first look at the code used 4%. A replay of the same turns with a 250k limit, a 60k handover and no other change used 46% of the tokens. The replay is optimistic, because a fresh lane reads some code again. A turn above 400k also took a median of 5.8 s, against 4.5 s between 100k and 250k.

So a lane hands over when its context passes a limit. The Claude Code package adds a `PostToolUse` hook that reads the delegate's own transcript and, when the last turn's input passes `CONDUCTOR_CONTEXT_LIMIT` (default 250k), tells it to finish the edit in hand, push its branch and send a Context full report with its work state. The orchestrator dispatches the same brief at the same tier with that report as context. A hook, not an instruction, carries the limit, because an agent cannot see its own context size and a rule it must remember fails late in a long context, when it matters most (encode-lessons-in-structure). The hook speaks to delegates only. The operator steers the session's own agent.

The same measurement changed three smaller rules. A ticket is flagged needs design only when a point depends on what the lane will find, because the orchestrator flagged three of four tickets in one epic for design points it could have settled from the code, and those lanes ran at frontier. Babysit waits on checks in the background and hands a failing log to an explorer, so a lane neither polls nor reads a whole log. And guard-the-context-window now asks for one edit per file per change, the diff instead of the file after an edit, and one status line per stage, because text-only turns used 10% to 13% of the tokens in sessions without lanes.

The limit can drop a detail a lane knew but did not write down. The Context full report carries each decision with its reason to limit that loss. Whether the limit changes the quality of the code is not measured yet.
