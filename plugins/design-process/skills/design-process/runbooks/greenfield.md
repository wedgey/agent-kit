# Runbook: a greenfield product

Use when there is no shipped app and no design system: a new product, or a new app beside an
existing one that will get its own look. Every phase runs, and the handoff builds the foundations
from nothing.

## Ground (phase 0)

- Read whatever exists: a brief, PRODUCT.md, research, a pitch, a prototype. Ask the owner for the
  one-line goal, the users, the jobs they hire the product for, constraints (platforms, stack,
  accessibility, brand assets already owned) and three products they admire. Quote it all in the plan.
- **Research before Structure.** Spawn researchers on the nearest competitors and on products
  that do the main job well. Capture screenshots. This is the reference set for every concept board.
- **Write the screen list from the jobs**, not from routes: for each job, the screens a user passes
  through, plus sign-in, settings, first run and empty states. Expect Structure rounds to change it.
- **Pick 3 anchor screens**: the screens of the most important job.
- Create the canvas and a project memory named `<product>-design-direction`.

## Phases

| # | Phase | Screens drawn per direction |
|---|---|---|
| 1 | Structure: the object model, navigation and the main loop. Draw a screen-map board per direction beside the anchor screens | the 3 anchor screens + a map |
| 2 | Look: type, density, surfaces, and the brand's voice in copy | the same 3 |
| 3 | Palette: brand, status and category colours, and tokens for light and dark | the same 3, plus a Tokens board |
| 4 | Details, one question at a time. Include first run, which a new product depends on | the same 3 |
| 5 | Every screen | one board per screen |
| 6 | Walk and edits, with tablet and phone | the edited screens |
| 7 | Handoff | none |

## Handoff

There is no DESIGN.md yet, so the first ticket writes it from the canvas, with the tokens and the
type scale, and sets up the UI kit. In this repo, that ticket runs the design framework's
`document` command. The next tickets build shared primitives, then the shell, then screens by the
main job's order. Publish with an epic, milestones and a project.
