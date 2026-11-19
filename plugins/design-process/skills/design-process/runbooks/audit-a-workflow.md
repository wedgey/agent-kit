# Runbook: audit a workflow screen by screen

Use when a flow already ships and works, and the job is to improve and tweak it: walk it as a user
does, mark what is wrong on each screen, and offer three fixes for each part. The look, palette and
shell are fixed by DESIGN.md, so the rounds decide structure, wording and behaviour, one stretch of
the flow at a time.

## Ground (phase 0)

- Ask the owner two things only: **which workflow** (its start and end, e.g. Library → new skill →
  editor → tests → add to an agent) and **the round shape** (default: findings, then three fixes).
- **Inventory** (explorer): every screen, dialog, sheet and state in the flow, with its route, its
  files and the gates or flags that change it. Save as `inventory.md`.
- **Capture the live flow** (screenshot-capturer or a throwaway e2e spec, never committed). Seed one
  realistic data set through the test fixtures, shoot each screen at 1440 in its own step so one
  failure does not stop the rest, and read every PNG back. Re-shoot with the canon data once it is
  written; a blank "Untitled" run hides real findings.
- **Findings log** (`findings.md`): per screen, numbered findings with severity (H blocks or
  misleads · M slows or confuses · L polish) and the standard each breaks in brackets. These are
  what the directions must close.
- **Canon** (`canon.md`): one sample object, one set of people, the vocabulary. Each round appends a
  "Round <x> data" section; boards never invent copy outside it.
- Create the answer page (`references/answer-page.md`) and a project memory, and write `plan.md` with the owner's words verbatim.

## Phases

| # | Phase | Runs? |
|---|---|---|
| 1 | Structure | only for a stretch of the flow whose structure is wrong |
| 2 | Look · 3 Palette | skip. Fixed by DESIGN.md |
| 4 | Details | yes: this is the audit. One stretch of the flow per round |
| 5 | Every screen | folded into the rounds: each round draws its screens with their states |
| 6 | Walk and edits | yes: the owner's picks and blends come back as edit rounds (`<round>b`, `<round>c`) |
| 7 | Handoff | yes |

## Each audit round

1. **Pick the stretch**: 1–4 neighbouring screens of the flow, in flow order. The first board of each
   direction may be the live screenshot with its findings marked; the rest draw the fix.
2. **Three directions that close the same findings**, each on the same screens with the same canon
   data, plus a Concept board with the reference screenshots and a cost table (new vs reused).
   Every screen board says which findings it closes.
3. **States are part of the screen**: each screen board carries a strip of up to 4 state cells
   (empty, loading, error, conflict, permission-limited, the risky path such as publishing while a
   review is open). Errors are plain lines in canon words.
4. **Research when the round borrows a pattern** (e.g. how GitHub or Google Docs review): two
   researchers in parallel, one per slice, while the drafters start; drafters build the Concept board
   last, once `refs/<round>-*.md` lands. Copy the shots into the page's `refs/` folder before the first full build, or Concept boards render empty frames.
5. **Generator per round**: `gen-<round>.cjs` is a harness that loads one `gen-<round>-<k>.cjs` per
   direction. `ONLY=<k>` builds one direction and never writes `round.json`, so drafters run in
   parallel; a full build writes `round.json`. Self-checks: one primary per screen
   frame (cut out regions behind a scrim), nothing under 12px, banned words, colour asserts.
6. **Drafters** (one per direction) write their own State line to the round plan and stay on for
   fix passes, reached with the continue verb.
7. **Read every PNG and check PNG height = board h.** `render.cjs --round` prints `overflow ...` and exits 1 for a
   board taller than its height.
8. **Reviewers**: the two design-process reviewers, given the PNG folder **and the board HTML path**
   for exact values. Review 1 scores freely; from review 2 the convergence rule applies (score only
   the last fix brief's items, regressions and hard standards failures; polish goes under
   "Optional, not scored"). Keep a `rejects-<round>.md` of settled rulings so a fresh reviewer does
   not reopen them. Each reviewer scores every board of the round in one pass (split only when a
   round passes ~12 boards), and the brief states the shell ruling: the shipped chrome is drawn, not
   reviewed.
9. **Fix briefs**: one common brief with your rulings (a reviewer conflict is yours to settle from
   the owner's earlier words, written as a ruling) plus one per direction. Small follow-up rulings go
   as quick 1b/1c passes. One fix pass plus the convergence rule usually gets every board to 6+.
   Polish the reviewers list as unscored goes into a short fix 2 brief only if it is cheap; the rest
   waits for the tickets.
10. Fill the scores in `round.json` (mean of the two reviewers) and the recommendation, publish the
    round's files in patch mode, mark the round open, arm the watcher, update memory, and send the
    owner the page's link. Then wait for the watcher.

## Edit rounds and the narrow round

- **A single-board edit** (the owner tweaks one approved screen) needs no drafter: the orchestrator
  reuses the direction's generator through a harness flag that writes only the edit's copy as
  a new board (key `E`, the round's one direction, screens numbered 1 to N), then runs the same two reviewers.
- **Tablet and phone come last, as their own round**: three ways the multi-pane screens fold
  (e.g. stack, pane tabs, main pane + sheets) on the anchor screens at 834 and 390, with a 320
  reflow check. The winner then draws every other screen once (a phase-5 round with an approval
  table instead of three directions); the owner approves per screen or names edits.

## What the owner decides

Per stretch: which direction, or a blend. A blend or a pick with tweaks becomes the next round
(`r3b`, `r3c`…), redrawing only what changed; a stretch the owner approves is fixed and
never reopened. The owner may approve some screens of a round and send others back.

## Handoff

Usually one ticket per screen or per stretch, with an epic once there are 4 or more. Add a ticket
for any cross-cutting rule the owner set during the audit (e.g. "the AI name is one constant"),
and list the findings each ticket closes. The precedence brief names, per screen, the chain of
edit boards newest first (`E*` boards > the edit rounds > the round that picked it), the narrow boards
that win at 834 and 390, and every unpicked direction under "Never build".
