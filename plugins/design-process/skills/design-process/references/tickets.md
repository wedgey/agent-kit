# Handoff: from final boards to issues and a project

The canvas now holds every round, and only some boards are final. Builders must never have to
work out which ones.

Every path below is relative to the repo root. `<work>` is the design work's folder outside
the repo (see SKILL.md, "Working practice").

## 1. Write the precedence brief (`<work>/tickets/BRIEF.md`)

Write it once and give it to every drafting agent. It holds:

- **The goal.** The product gets built to match the canvas exactly. One implementer per issue must
  build pixel-close without guessing.
- **Paths.** The board HTML, the board PNGs, the generator, the canon, `callout.sh`, and where to
  write. Give the canvas URL and slug, and say that implementers can read any board with the
  artifact server's `read_file` tool (`project/<Board>.dc.html`). The canvas is private, so they
  ask the owner for access.
- **Which board wins.** Go part by part:
  1. *Chrome* (rail, panels, top bar, folding, phone drawer and tabs): only the boards of the
     round that settled navigation. With no such round (a feature inside an existing shell), the
     current app's chrome, untouched. Every older board's chrome is superseded, and the issue must say so.
  2. *Colour and tokens*: the chosen palette and Tokens board, or the repo's DESIGN.md when no
     palette round ran.
  3. *Screen body*: the newest board that draws that screen. Write out the full order, newest
     first (e.g. edits > every-screen round > workspace round > look rounds).
  4. *Never build*: list every prefix that was not chosen.
  5. *Words*: any rename map from later rounds, plus the canon.
  6. *Responsive*: the tablet and phone boards win for those widths.
  7. *Data*: sample data is layout, not values. "(placeholder)" copy is not final.
- **Repo rules** each issue must restate: test-first, lint, typecheck, e2e and proof media, i18n
  keys, import boundaries, icon and component limits, tokens only, and the flag or ship-live
  policy. Read them from AGENTS.md or CONTRIBUTING.
- **The reference logs** (`<work>/refs/`), so each issue can cite the products behind its boards.
- **The standards** from `references/rounds.md`, which each issue's Done when restates.
- **The issue template** below, the placeholder forms, the file format and the full ticket list.

## 2. Cut the tickets

Start from the screen list and the Index's build order. Use one ticket per screen or family
that a reviewer can judge in one sitting. Then:

- Make foundations first, when the work changes them: tokens and the design doc, shared
  primitives, the desktop shell, and the tablet and phone shell. Every screen ticket is blocked by
  the foundations it uses.
- **Size the handoff.** One to three tickets need no epic, milestones or project: leave `EPIC.md`
  out, `milestones` and `project` out of the config, and the template's `Part of {{EPIC}}` line out
  of every ticket. Four or more get all three. Group them into
  milestones by build order and put the graph in the epic as Mermaid.
- Write the "Blocked by:" line from real dependencies only.

## 3. Draft in parallel

Spawn one drafting agent per 2–5 related tickets. Give each the brief and its tickets. Each one
reads the board HTML for exact values and crops callouts with `callout.sh`:

```bash
<skill dir>/scripts/callout.sh full.png crop.png 900x500+40+120 120,60,1 300,60,2   # x,y are in the crop's pixels
```

Then it reads every crop back to check that each marker sits on the thing it names. It writes
`<work>/tickets/T<NN>-<slug>.md` and `<work>/tickets/img/T<NN>-*.png`, and reports open product questions in one
line each, with a proposed default.

## The issue template

```
Part of {{EPIC}}          (omit when there is no EPIC.md)

**Boards:** `<Board>` (wins), `<Board>` (body) on the [design canvas](<url>), page *<page>*.
Read exact CSS with the artifact server's `read_file` tool: slug `<slug>`, path `project/<Board>.dc.html`.
The canvas is private; ask the repo owner for access.

**Route:** `<route>` · **Replaces:** `<current files>`

**References:** the products behind these boards, from `<work>/refs/<round>.md` (name, URL, what it gave).

{{IMG:/abs/full.png|<Board> at 1440|1000}}

## What changes        (2–5 sentences: before and after, for the user)
## Callouts            ({{IMG:crop}} then a table: # | Element | Spec: px, weight, token + hex, Lucide icon, copy; every marker has a row; values come from the HTML)
## Layout              (grid, widths, gaps, max widths, what scrolls, what sticks)
## Behaviour and states (clicks, keys, hover, focus, loading, empty, error, permissions, overflow; cite the state boards; "not drawn: follow <rule>" otherwise)
## Responsive          (1440, 1280, any layout breakpoint the boards define, 834, 390; cite the boards)
## Copy                (key → text for every visible string; mark sample data)
## Data                (fields and the existing query or action; anything the backend must add, said plainly)
## Out of scope        (what neighbouring tickets own)
## Done when
- [ ] Matches the board at 1440 and 1280 (overlay the screenshot; differences only from real data)
- [ ] …screen-specific checks…
- [ ] Tablet and phone match their boards
- [ ] Meets the standards: WCAG 2.2 AA (contrast, focus, targets, labels), every state drawn or named
- [ ] Only foundation tokens and primitives; no one-off colour, radius or type size
- [ ] …the repo's own done rules from the brief's Repo rules list (for example i18n, e2e, PR media)…

Blocked by: {{T:01}}, {{T:03}}
```

Line 1 of each file is `# <title>`. Line 2 is `labels: <work label>, area:<app>, size:S|M|L`.
The placeholders are `{{EPIC}}`, `{{T:NN}}` and `{{IMG:/abs/path.png|alt|width}}`; the script
resolves them to issue numbers and hosted images.

## 4. The epic (`<work>/tickets/EPIC.md`, large handoffs only)

It holds:
- the goal and the canvas link, with an access note;
- the precedence rules in short form;
- the milestones and the Mermaid dependency graph;
- the owner questions, each with a proposed default;
- the ship policy;
- how to run each ticket.

If the repo has a past epic, read it and follow its format.

## 5. Check, publish, report

1. Spot-check a few tickets and crops yourself. Check that the values match the HTML, the markers
   land on the right things, and no superseded chrome has crept in.
2. Write `<work>/tickets/config.json`:
   `{ "repo", "owner", "project", "milestones": {"M1": ["Title", ["01","02"]]}, "upload" }`.
   `upload` is a command that hosts one image and prints its URL as the last line. The script
   fills in `{path}` and `{repo}`. Use the repo's own upload command if it has one. For a private
   repo, use one that posts to GitHub user-attachments, which stay private.
3. From the repo root, run `node <skill dir>/scripts/publish-issues.mjs <work>/tickets check` until it
   reports 0 problems. Creating the project needs the `project` token scope, so run
   `gh auth refresh -s project` first. Then run the same command with `run`. Progress is kept in
   `<work>/tickets/state.json`, so a rerun after a failure resumes and never rewrites a body it
   already wrote.
4. Report to the owner:
   - the project and epic links;
   - a ticket table with number, title, boards, milestone and blocked-by;
   - the open questions with their defaults;
   - what you did not verify.
