# The Design canvas, the boards, and how they get there

## Create the canvas once

1. Call `mcp__claude-artifacts__guide` with the `pages` topic, then with `design`.
2. Call `list_types` and pick the **Design** type ("Design canvas for websites … screens, UI mockups …: live
   artboards laid out on a canvas"). Its slug differs per org, so never hardcode it. Run
   `describe_type` once to see the file layout it expects.
3. Run `create_from_type` with that slug and a title such as "<Product> UX directions". Keep the new
   artifact's slug and URL in the plan and in memory. It starts private, and only the owner can share it.
4. Run `list_files`, then `read_file` on `project/canvas.json` and on one starter `*.dc.html`, before
   writing your own files. The type's support files (e.g. `support.js`) stay where they are.

## Files

- `project/canvas.json` holds the layout of every page:
  ```json
  { "pages": [{ "id": "r3", "name": "Round 3: the look" }],
    "launch": { "view": "canvas", "page": "r3" },
    "boards": { "P1-Concept.dc.html": { "x": 0, "y": 0, "w": 1440, "h": 2400, "title": "P1 · Concept",
                "expand": "fill", "is_interactive": true, "page": "r3" } },
    "notes":  { "r3-P": { "page": "r3", "x": 0, "y": -240, "text": "P · The Proof", "kind": "title1", "maxW": 9000 } },
    "order":  ["P1-Concept.dc.html"] }
  ```
  Put each new page first in `pages` and point `launch` at it. Lay out one row per direction or
  family: boards 1440 wide at `x = j * 1520`, rows `max(h) + 480` apart, and a `title1` note 240
  above each row. When you rebuild a page, delete its old boards and notes first so renamed
  boards don't linger.
- `project/<Prefix><n>-<Name>.dc.html` is one board. Start from the starter's skeleton:
  `<script src="./support.js">`, `<x-dc>`, then a `<helmet>` with fonts and a reset, then one root
  `<div>` with inline styles. Use real HTML, inline styles and Lucide SVGs, and no external JS.
  Give each direction a short prefix (2 letters once single letters run out). Number its boards
  0 (Concept), 1, 2…, and keep the same screen numbers across directions.
- **Images** (reference screenshots): upload them with `upload_asset`. It returns a `/_blob/<hash>`
  path. Store `{name: "/_blob/<hash>"}` in a `blobs.json` beside the generator, so `render.cjs` can
  serve the local copy.

## The generator

Write one node script per round, kept in the working folder. A small helper set does most of the work:
`t(text, size, colour, css)`, `P()`, `h2()`, `pill()`, `icon(name)` (Lucide paths), `tbl()`, `mini(html, {scale})` (a
scaled live copy of another board, for decision-board column heads), and `board(file, title, body, height, railColour)`.
`board()` writes the file, records its height and pushes it onto the round's list.

- **Directions are theme objects.** Write a shared skeleton (`skel`) that draws each chosen screen
  from a theme `{ k, name, colours, type, rail, …slots }`. Each direction is then a theme object, so
  "redraw the same screens in a new look" costs one object. Later rounds copy the previous script
  and replace only the round's part. Keep old scripts so earlier pages can be rebuilt.
- **Colour comes through `colour.cjs`.** Define colours with `OKC(L, C, h)`, which throws when a
  colour is outside sRGB, or `fit()`, which clamps chroma into it. Call `need(fg, bg, 4.5, what)` for
  every text pair you draw and `need(…, 3, …)` for marks. Assert the round's banned colours too,
  such as colours from a rejected palette or AI hues used on non-AI elements. Print the counts and
  quote them on the decision board: "Checked: N text pairs at 4.5:1, M marks at 3:1, K colours in sRGB".
- **Canon.** From Ground on, keep `canon.md` beside the generator. It holds one
  vocabulary, one data set, one pattern per recurring thing (the disabled button, the dismiss label,
  the scrim, error glyphs) and the minimum text size. Every family delegate reads it first. When a
  reviewer finds an inconsistency, fix the canon and then the boards.

## Render, check, publish

```bash
# from the repo root (Playwright resolves from there or apps/*), or set PLAYWRIGHT_PATH
node <skill dir>/scripts/render.cjs <work>/canvas/project <work>/shots \
  R3-Choose.dc.html P1-Concept.dc.html … --blobs <work>/blobs.json --shots <work>/refshots
```

- If a PNG is taller than the height passed to `board()`, the content overflows the board. Fail
  the build on that.
- It writes three things. `<shots>/<Board>.png` is the full board, for overflow checks, callout
  crops and publishing. `<shots>/review/<Board>-<n>.png` are 864x720 tiles of the board at 0.6
  scale, readable and about 830 image tokens each. `<shots>/sheets/<Prefix>.png` is one contact
  sheet per board prefix, with every board of that prefix on disk.
- Read the sheets to scan a direction, and the tiles of each changed board before review. Never
  read a full-size board whole: anything over about 1568px on its long edge is shrunk on read, so a
  tall board's text becomes unreadable. Crop a full-size PNG only for a region you need at 1:1.
- Publish with `publish_files`, `mode: "patch"`. Send `project/canvas.json` and the changed boards
  only, with `base_version` from the last publish. Give a `label` such as "Round 5: three looks". On
  a conflict, run `get_artifact` and retry with the live version.
- Small copy fixes to one board can use `edit_version` with `path: "project/<Board>.dc.html"`.
