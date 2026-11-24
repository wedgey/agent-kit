# A lane compacts at about 107k

ADR 0018 set the lane agent's `autoCompactWindow` to 120000. Claude Code compacts about 33k below the window, so a lane compacted at a median 88k across 1,253 compactions. A lane starts at about 44k (instructions, the skill listing, the deferred tool list, tool schemas, its brief) and comes back from a compaction at about 63k, so it had about 23k to work in. On 2026-11-23 lanes compacted 285 times in one day, every few calls, and each compaction re-cached about 63k.

So the window is 140000, and a lane compacts at about 107k. That is about twice the room to work in. A replay of that day's 30 lane transcripts at API prices, with each compaction modelled as one summary call, put the saving at about 8% of the day's spend. The 278 compactions the replay could place fell to 146 at a 110k trigger. Compactions at a 120000 window ranged from 87k to 96k, so a window much above 140000 would push many above the context guard's 120k delegate limit, and the guard would then note nearly every lane compaction.

The drafters of design-process ADR 0003 run at 200000 and compacted at 168k, which is where the 33k gap comes from.
