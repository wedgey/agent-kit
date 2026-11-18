---
name: design-process
description: Runs design work from a question to build-ready GitHub issues, for any scope - an app redesign, a new feature or flow, or a greenfield product. Works in rounds of three directions drawn as live boards on a claude.ai Design canvas artifact. Each round has a "What you're choosing" board, reference screenshots, colour and contrast checks, and two independent reviewers scoring every board out of 7. The owner picks a direction each round. At the end it writes a precedence brief, drafts one detailed issue per screen with numbered callout crops, and publishes the issues (with an epic, milestones, blocked-by links and a GitHub Project when the work is large). Use when the user wants options to choose between for a redesign, a new feature's UX, or a new product's look and structure; wants mockups on a canvas; or wants a finished canvas turned into issues.
---

# Design process: rounds of three directions, then tickets

The owner steers by choosing. Your job each round is to make the choice easy and well grounded:
three directions, drawn at equal depth on the same screens, compared on the same criteria, checked
before they are shown. Once the design is final, you hand it to builders as issues that leave
nothing to guess.

This skill decides *what to build*. Building it still runs through the repo's own design
framework, if it has one, issue by issue. For one small UI change with no real options to weigh,
skip this process and build it directly.

## Pick a runbook

Each runbook says what Ground covers, which phases run, and how big the handoff is. Read it first.

| The work | Runbook |
|---|---|
| Rethink an existing app's structure, look, colours or navigation | `runbooks/redesign.md` |
| Add a feature, flow or screen to an existing product, inside its design system | `runbooks/new-feature.md` |
| A new product or app with no design system yet | `runbooks/greenfield.md` |
| Improve a flow that already ships, screen by screen: findings, then three fixes per stretch | `runbooks/audit-a-workflow.md` |

Nothing fits? Use the closest runbook, and tell the owner which phases you changed and why.

Read these when you reach the step that needs them:
- `references/rounds.md`: the decision board, concept boards, research, colour and the reviewer loop.
- `references/canvas.md`: the Design canvas artifact, the board files, the generator, render and publish.
- `references/tickets.md`: the handoff. The precedence brief, the issue template, drafting and publishing.
- `bindings/<harness>.md`: the only place a model or tool is named. Read yours before the first spawn.
- `scripts/`: `render.cjs` (boards to PNGs, review tiles and contact sheets), `colour.cjs` (sRGB gamut and WCAG checks), `callout.sh`
  (numbered crop markers, needs ImageMagick), `publish-issues.mjs` (epic, issues, milestones, project).

## Rules the owner taught us (they hold for every round, in every runbook)

1. **Exactly three directions per round**, unless the owner names another number. No fourth "safe"
   option. Fold it into the three, or mention it in chat.
2. **Equal depth.** Each direction gets its own concept board and the same set of screens, in its own look.
3. **Every round opens with a "What you're choosing" board.** It has three boxes: Already decided,
   Decided this round and Next round. Below them is one table comparing the directions on fixed
   criteria. The criteria are the same every round. See `references/rounds.md`.
4. **A round narrows one question and never reopens earlier ones.** Later rounds redraw the chosen
   screens with the same copy and data, and only the open question varies. Name any small structural
   tweak on the decision board.
5. **Show the references.** A concept board shows screenshots of the real products behind it, not only
   their names. Research at least 10 well-rated designs before a look or pattern round.
6. **Every colour is in sRGB and every text pair passes WCAG AA.** Text needs 4.5:1 and marks need
   3:1. The generator asserts it with `scripts/colour.cjs`. Never put a gradient or translucency
   behind body text.
7. **One sample data set and one vocabulary across all boards.** Write them in a canon file. Mark
   invented copy "(placeholder)".
8. **Never overwrite an earlier round.** Each round gets its own canvas page. Edits to drawn screens go
   on the new page as `E<board>` copies.
9. **No board reaches the owner below 6/7.** Two independent reviewers on different models score
   every board out of 7. Fix and rescore until both give 6 or more.
10. **Record every decision the day it is made.** Write it to a project memory, quoting the owner,
    with the date and the canvas version. The next round starts from it.

## The four things every piece of design work gets

**Options.** The owner chooses between three directions each round, never approves one. Every
direction is drawn on the same screens with the same data. The report ends with a table scoring
each direction out of 7 on the fixed scored rows in `references/rounds.md`, a recommendation with its reason, and the question asked
as options.

**Standards.** Every board meets the standards in `references/rounds.md` ("Standards every board
meets"): WCAG 2.2 AA, the platform conventions, usability heuristics, every state accounted for,
the repo's DESIGN.md (once one exists) and the canon. The generator asserts what it can. The reviewers check the rest by name.

**Senior design review.** Two reviewers who did not draw the boards play senior UI/UX designers
with 20 years on scalable, award-winning products. They score every board out of 7 against those
standards, on different models, in parallel. Nothing reaches the owner below 6 from both.

**Documented references.** Every look, pattern or colour choice traces to real products. Each
round keeps a reference log (`<work>/refs/<round>.md`): product, URL, screenshot, what it gave
which direction. Concept boards show the screenshots. Issues list the picks (name, URL, what it gave) behind the boards they cite.

## Who does what (subagents)

You orchestrate, write every brief, and make every call. Delegates do scoped pieces in parallel.
Briefs live in the working folder. Each role is its own agent, with its own model, effort and
tool limits. Your harness's binding maps each role to it. Never run a role on a generic agent that
inherits your model.

| Role | When | Brief and output |
|---|---|---|
| Explorer | Ground | Read the repo or brief. Return the screen list with purpose, objects and current files |
| Researcher (2–4) | Before a look, pattern or colour round | One slice of sources each. Return 10+ picks with URL, screenshot and one line. Brief in `references/rounds.md` |
| Board drafter (one per direction or family) | Every round | The canon, the generator helpers and its screens. Return boards that pass the colour asserts. It stays alive and applies its own fix passes |
| Screenshot capturer | Every render, reference capture and callout crop | Board files, URLs or crop coordinates. Return the files, overflow lines and broken renders. Judges nothing about the design |
| Fixer | A fix pass when the board's drafter is gone | A numbered fix list and the boards it names. Decides nothing else |
| Senior reviewer and second reviewer (different models) | Every round, until every board is 6/7+ | The reviewer brief in `references/rounds.md`. Read-only. Return scores and exact fixes |
| Ticket drafter (one per 2–5 tickets) | Handoff | The precedence brief and its tickets. Return issue files, callout crops and open questions |

A delegate never reviews its own boards. Read every board and every report yourself before it
reaches the owner: a delegate's "done" is a claim.

## Context budget

Every delegate re-reads its whole context on every turn, so a delegate that has read 200 screenshots
pays for them on every step after. Images are most of the cost of design work. These rules hold for
you and for every brief you write.

- **Read tiles and sheets, not full boards.** `render.cjs` writes each board as review tiles
  (`<shots>/review/`) and each direction as a contact sheet (`<shots>/sheets/`). A full-size board
  is shrunk on read until its text is unreadable, so it costs tokens and shows nothing. Open a
  full-size PNG only to crop a region the brief names.
- **Read each image once.** On a rescore or a fix pass, read only the boards that changed.
- **Fix passes go back to the drafter**, who still holds the canon and the generator. Spawn a fixer
  only when the drafter is gone.
- **Pass paths and excerpts, not documents.** A brief names the sections of the canon, plan and
  references to read. Never print a whole brief or canon through the shell.
- **Two reviewers per board, no more.** Add a third view only when the owner asks for it.
- **Escalate by evidence.** A role moves up a model only after its gate fails, as the binding says.

## The general sequence

Every runbook uses these phases. It skips the ones its scope has already settled, and says which.
A runbook may add a phase between 4 and 5 for one more question. It names that phase's screens.

| # | Phase | What it settles |
|---|---|---|
| 0 | Ground | Nothing yet. Read what exists, write the goal and constraints, list the screens, pick the anchor screens, create the canvas and the plan |
| 1 | Structure | How the work is organised: where the core task happens and how a user moves through it |
| 2 | Look | The feel: type, density, surfaces |
| 3 | Palette | Brand and status colours, and tokens for light and dark |
| 4 | Details | One open question at a time, such as how AI output is marked or how an error recovers |
| 5 | Every screen | Draw each remaining screen once in the winner, grouped by family, with its states |
| 6 | Walk and edits | The owner walks the screens. Draw their edits, tablet and phone, on a new page |
| 7 | Handoff | Turn the final boards into issues |

The **anchor screens** are the 2–4 screens that carry the main loop of the work. Every round in
phases 1–4 redraws them, so directions stay comparable. Rounds repeat until the owner picks. When
they reject all three, research again, widen the search and return with brand-new directions. When
they like parts of several, the next round blends those parts and adds new ones.

## Each round, step by step

1. **Write the round plan** in the working folder. It quotes the owner verbatim, lists what is fixed and
   what is open, names the directions with board prefixes, sets the screen list and the data. Keep a
   short state section at its foot for compaction.
2. **Research when the round is about look, colour or pattern.** Spawn researchers in parallel. Each
   one covers a slice of sources (Awwwards, Dribbble, Mobbin, product sites, design-system docs) and
   captures live-site screenshots with Playwright. Some sites block screenshot bots, so note them and move on.
3. **Build the boards with the generator.** Write the shared skeleton once, then one generator file
   and theme object per direction, so every direction redraws the same screens. Run the colour asserts. See `references/canvas.md`.
4. **Render and look.** Have the screenshot capturer render the changed boards, then read the contact sheets and each changed
   board's review tiles yourself. Check for overflow, clipped text, wrong data and stray process words.
5. **Review loop.** Give the review tiles and sheets to the two reviewer agents with the brief in
   `references/rounds.md`. Fix what they find and rescore until both score every board 6/7 or more.
6. **Publish** the changed files only, in patch mode. Set the canvas launch page to the new round.
7. **Update memory** with the round, its version id, the working folder's path and what is open.
8. **Report to the owner.** Give the canvas link and one line per direction. Then a table scoring the
   directions out of 7 on the round's criteria, your recommendation, and the question as options.
   End with what you did not check, such as user testing or colour-blindness simulation.

## Working practice

- Orchestrate. Delegate research, board families and reviews to parallel agents with written briefs,
  and keep the decisions and the final read yourself. Briefs live in the working folder so a
  compaction loses nothing.
- Keep all generated files in one working folder per piece of design work, outside the repo (for
  example `~/design/<name>/`), not the session scratchpad, which a later session cannot find.
  Record its path in memory in step 7. Phases 0 to 6 change no repo file. DESIGN.md, the tokens
  and the screens change later, through the issues.
- Long sessions will compact. Before that happens, write the state into the round plan's last section.
