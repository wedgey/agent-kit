# The evidence behind the Claude Code binding

Conductor's ADR 0025 says instruction files hold only what to do. This change moves the evidence out of design-process's Claude Code binding. The rules stay there.

- **Role agents, not `general-purpose`.** In one landing-page project in November 2026, 140 of 141 delegates ran as `general-purpose` on the session's model, read 3,093 screenshots between them, and grew to 250k to 290k tokens each. See ADR 0001.
- **The senior reviewer on `fable`.** Per Artificial Analysis's index and Anthropic's pricing, read 2026-11-17, `fable` at `low` scores 54, above `opus` at `high` (52), for about the same output cost. A review reads a few dozen tiles and writes a short report, so `fable`'s higher input price matters little there. Roles that write boards or tickets write about 100k tokens each and build large caches, which would cost about twice as much on `fable`.
