# Rounds: the decision board, research, colour and review

## "What you're choosing" (the top of the answer page)

You write it into `round.json` (`references/answer-page.md`); the page draws it.

- A head that names the round and its one question, in a sentence.
- Three boxes: **Already decided** (bullets), **Decided this round**, **Next round**.
- **One card per direction**, with its concept board's thumbnail, linked to the board: In one line ·
  Feels like · Pick it if. Colour, type, density, the product's key differentiator (e.g. how AI
  suggestions show), the signature moment, and strongest and weakest at go on the concept board.
- **Scored rows**, below the descriptive ones, each direction out of 7: **Fits the main task** ·
  **Clarity and hierarchy** · **Meets the standards** · **Distinct from competitors** · **Scales to
  every screen** · **Cost to build** (cheaper scores higher). Each score is the mean of the two
  reviewers'. Add an **Overall /7** row, which is your judgement, not an average.
- A recommendation line with its reason.
- A note under the table with the check counts from the generator and what was not checked.
- A round with several sub-choices (colour, navigation, edits to confirm) makes each one a screen
  of the round, so each gets its own pick.

## A concept board (`<P>0`)

The idea in a sentence, then why it fits this product and these users. Then 3 or more reference
screenshots, each with the product's name and what it gave this direction. Then palette swatches
with hex and contrast, the type pair, how it maps onto the UI kit's tokens, the signature moment,
and the risk. A palette round adds a Tokens board: every token for light and dark, plus status,
AI and category colours, each with its contrast ratio.

## Research brief, in outline

The goal and the owner's words. What the round decides. The sources to cover, split between the
researchers. For each pick, the URL, a screenshot of the live page saved as `<name>.jpg` in the
round's shots folder, and one line on what it would give us, written to that researcher's own picks file. At least 10 picks per researcher.
Report the sites that block bots. Ask for no opinions on the owner's choice.

Merge the researchers' picks into the round's reference log, `<work>/refs/<round>.md`, one row per
pick: product, URL, screenshot path (and its `refs/` path on the page), what it gave, and which
direction used it. A concept board cites only picks in the log.

## Standards every board meets

- **Accessibility, WCAG 2.2 AA.** Text 4.5:1 and large text or marks 3:1. Colour never the only
  signal. A visible focus state on every control. Targets 24×24 px minimum (44 on touch layouts).
  Text at least 12px. Labels on every input. Motion that can be reduced.
- **Usability heuristics** (Nielsen's ten). Above all: system status is visible, the user can undo
  or leave, the same thing looks and is named the same everywhere, errors say what happened and how
  to recover.
- **Platform conventions.** Web patterns users already know: links look like links, standard
  keyboard shortcuts, dialogs that close on Escape. Tablet and phone follow the touch conventions
  of Apple's Human Interface Guidelines and Material Design.
- **States.** Each screen accounts for empty, loading, error, partial, overflow (long names, many
  rows) and permission-limited views, drawn or named.
- **The repo's design system.** DESIGN.md and its tokens once they exist; the canon always.


## Colour rounds

- Hold every colour as `OKC()` or `fit()` in the generator. If a hue the owner asks for doesn't fit
  sRGB at the needed lightness, say so and show the nearest one that does.
- **Hue zones.** Reserve hues for meaning: error, warning, success, AI. Keep category colours out of
  those zones, and avoid the generic indigo or violet "AI slop" zone unless chosen.
- **Competitor check.** Compare the brand hue against the nearest competitors' brand colours. If
  they are close, separate the brand with lightness or a second colour.
- Map the result onto the UI kit's tokens (`--primary`, `--accent`, `--sidebar`, …). Say which
  token names change meaning; that rename is the biggest later code change.

## The reviewer loop

Spawn the senior reviewer and the second reviewer agents in parallel. They are read-only and run on
different models, one strong and thorough, one fast. Each gets this brief:

> You are a senior UI/UX and brand designer with 20 years designing scalable, award-winning SaaS
> products and their design systems. Give an independent, opinionated review; do not edit files.
> Context: <product, users, the owner's words, what is fixed, what this round decides>.
> Read the contact sheets in <shots dir>/sheets and the review tiles in <shots dir>/review (and the
> board HTML in <project dir> for exact values) and the canon sections <named>.
> For each board: a score out of 7, the three most important problems with exact fixes, and
> anything that breaks the canon, the shared data, or the standards in "Standards every board meets"
> (paste them here), naming the standard each finding breaks. Then score each direction out of 7 on
> each scored row (paste them here), rank the directions for this product and say why.

Merge the two reports and fix every point both raise. For points only one raises, fix them or
note why not. Send each direction's fixes as one numbered list to the drafter that drew it, which is
still running. Use a fixer only when that drafter is gone. Re-render and send only the changed
boards for rescoring. Stop when both score every
board 6 or more. Tell the owner the final scores. Three passes is normal.

## Every screen

- Group the screen list from Ground into families, each with a two-letter prefix (Au sign-in, Se settings,
  Ov overlays, St states…). Each family gets one delegate with the canon, the helper file and its
  routes. It draws one board per screen in the winning direction. States (empty, error, loading,
  read-only) and overlays (palette, dialogs) are families too.
- Add an Index board with every family, its boards, and the **build order**: tokens and the design
  doc first (when they change), then the shell (when it changes), then screens by traffic, with
  onboarding last. The runbook says which of these apply.
- Give options only where a real choice is open, such as onboarding. Those get their own 3
  directions and their own round on the page.

## Walk and edits

Walk the owner through each family, or each screen when there are few. Quote their edits verbatim in the plan. Draw them as boards of the round's one direction, key `E`, numbered 1 to N one per edit
(`E1`, `E2`, ...), in a new round with the old boards untouched, one screen per edit, so the owner confirms or
changes each one. Draw tablet (834) and phone (390) for each layout pattern the work touches; the
runbook lists them. A navigation or colour question raised in the walk
becomes its own round of three.
