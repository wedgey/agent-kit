# A small routine review runs at strong-code

Every review ran at frontier. On 2026-11-23 conductor's 41 reviews ran on `opus` and were 10% of the day's spend, $40.50 of $421 at API prices. The same tokens on `sonnet` cost half, at $2/$10 against $4/$20 per million. Most were one ticket's PR in an epic, reviewed again after small fixes.

So a review runs at strong-code when the diff is small and routine: at most 300 lines inserted plus deleted, not counting lockfiles and generated files, no change to authentication, security, payments, data migrations or concurrency, and not a ticket that needs design. A re-review after fixes counts only what changed since the head it last reviewed. Every other review runs at frontier. The reviewer agent keeps frontier as its default and the spawn passes strong-code, so a spawn that forgets the model pays for a frontier review instead of getting a weaker one, as ADR 0006 intends.

The 300-line bar is a starting point, not a measurement. Revisit it once reviews at strong-code have a record of what they missed.
