# Context Map

## Contexts

- [Conductor](./docs/conductor/CONTEXT.md): the agent mode that sets how a coding agent works, delegates and verifies, in any harness
- [Design process](./docs/design-process/CONTEXT.md): rounds of three design directions on a canvas, reviewed and scored, then build-ready issues

## Relationships

- **Conductor → other catalog entries**: none. Conductor never references another entry (ADR conductor/0001).
- **Design process → other catalog entries**: none. It ships its own role agents and never needs conductor installed.
