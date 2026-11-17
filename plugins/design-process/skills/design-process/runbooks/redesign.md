# Runbook: redesign an existing app

Use when the owner wants to rethink an app that already ships: its structure, look, colours or
navigation. Every phase runs. The handoff is large: an epic, milestones and a project.

## Ground (phase 0)

- Read the repo's DESIGN.md, PRODUCT.md (or the README), AGENTS.md and the UI kit (e.g. shadcn
  config, registries). Ask the owner for their constraints and their one-line goal, and quote both in the plan.
- **Inventory every route** with an explorer delegate. List each screen with its purpose, its main
  objects and its current file. This list is the screen list. It becomes the Every screen board
  list and the ticket list.
- **Pick 3 anchor screens**: the ones that carry the product's main loop, such as the main object's
  page, the main correction or editing action, and publishing.
- Create the canvas (`references/canvas.md`) and a project memory named `<product>-redesign-direction`.

## Phases

| # | Phase | Screens drawn per direction |
|---|---|---|
| 1 | Structure | the 3 anchor screens |
| 2 | Look. Research first, references on every concept board | the same 3 |
| 3 | Palette, with a hue check against competitors | the same 3, plus a Tokens board |
| 4 | Details, one visual question at a time | the same 3 |
| 4b | Workspace layer: navigation, home and record lists | home and the main lists |
| 5 | Every screen: each remaining route once, in the winner. 3 options only where a real choice is open | one board per screen |
| 6 | Walk and edits, with tablet and phone for rules, home, a list, a detail, the editor, sign-in and a dialog | the edited screens |
| 7 | Handoff | none |

## Handoff

Foundations come first: tokens and DESIGN.md, shared primitives, the desktop shell, then the
tablet and phone shell. Every screen ticket is blocked by them. Publish with an epic, milestones by
build order and a GitHub Project. Label every ticket `redesign`.
