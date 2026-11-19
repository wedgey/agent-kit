# Runbook: a new feature, flow or screen in an existing product

Use when the product and its design system already exist and the work adds to them: a new flow, a
new object's pages, a new setting. The look and palette are fixed, so the rounds decide structure
and behaviour.

## Ground (phase 0)

- Read DESIGN.md, PRODUCT.md (or the README), AGENTS.md, the UI kit, and the issue or brief that
  asked for the feature. Quote the owner's goal and constraints in the plan.
- Read the neighbouring screens the feature joins, in code and in the running app. Screenshot them
  at 1440: every board starts from the real chrome around the feature.
- **Write the screen list**: every screen, dialog and state the feature adds or changes, with its
  entry points from existing screens.
- **Pick 2–3 anchor screens**: where the feature's main task happens and where a user first meets it.
- **Theme the generator from DESIGN.md**, not from a new direction. Assert that every colour is a
  DESIGN.md token. A board that needs a new token is a finding for the owner, not a quiet addition.
- Create the answer page, or add rounds to the product's existing one, and a project memory named
  `<feature>-design`.

## Phases

| # | Phase | Runs? |
|---|---|---|
| 1 | Structure: where the feature lives and the flow through it | yes. Three directions on the anchor screens |
| 2 | Look | skip. Fixed by DESIGN.md |
| 3 | Palette | skip. Fixed by DESIGN.md |
| 4 | Details: one open question at a time, such as empty state, error recovery or AI output | when a real choice is open |
| 5 | Every screen, with its states | yes |
| 6 | Walk and edits, with tablet and phone | yes |
| 7 | Handoff | yes |

The "What you're choosing" board still compares on fixed criteria. Swap the Feels like, Colour, Type and
Density rows for **Steps to finish the task**, **Where users find it** and **What it changes in existing screens**.

## Handoff

Usually 1–3 tickets: no epic, milestones or project (`references/tickets.md`, "Size the handoff").
Chrome and tokens come from the current app, so the precedence brief only orders the feature's own
rounds. If the work needed new tokens or primitives, put them in a first ticket that the others are
blocked by.
