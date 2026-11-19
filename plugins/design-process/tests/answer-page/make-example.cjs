// node make-example.cjs <exampleDir> : writes a neutral round.json and boards/*.html for the template's example
const fs = require("fs"), path = require("path");
const out = process.argv[2], B = path.join(out, "boards");
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(B, { recursive: true });
const dirs = {
  A: { name: "Quick add", ovr: 5, line: "A field at the top of the list; press Enter and it is saved.", feels: "A plain to-do list.", pickIf: "Speed matters more than detail.", c: "#1f5f8b" },
  B: { name: "Add sheet", ovr: 6, line: "An Add button opens a sheet with title, date and list.", feels: "A calendar app's new event.", pickIf: "Most notes need a date.", rec: true, c: "#2e6b3f" },
  C: { name: "Type anything", ovr: 4.5, line: "One box reads 'call Sam Friday' and fills the fields.", feels: "A command bar.", pickIf: "You want typing to do the work.", c: "#7a3e8f" } };
const screens = [{ n: 1, title: "Empty list" }, { n: 2, title: "Adding a note" }, { n: 3, title: "The list with notes" }];
const H = 900, heights = {};
const page = (id, title, body, c) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${id} · ${title}</title><style>body{margin:0}</style></head><body>
<div style="width:1440px;min-height:${H}px;box-sizing:border-box;font:16px/1.5 system-ui,sans-serif;color:#1d1d24;background:#fff">
<div style="height:64px;display:flex;align-items:center;padding:0 24px;border-bottom:1px solid #e4e4e8;background:#f7f7f9;font-weight:700">${id} · ${title}</div>
<div style="padding:48px 64px"><div style="height:6px;width:120px;background:${c};border-radius:3px;margin-bottom:24px"></div>${body}</div></div></body></html>`;
const btn = (to, label, c) => `<button data-goto="${to}" style="font:inherit;background:${c};color:#fff;border:0;border-radius:8px;padding:12px 20px;cursor:pointer">${label}</button>`;
for (const [k, d] of Object.entries(dirs)) {
  const w = (n, title, body) => { fs.writeFileSync(`${B}/${k}${n}.html`, page(`${k}${n}`, title, body, d.c)); heights[`${k}${n}`] = H; };
  w(0, `${d.name}: concept`, `<h1 style="font-size:40px;margin:0 0 12px">${d.name}</h1><p style="font-size:20px;max-width:760px">${d.line}</p><p style="color:#55556a">Feels like: ${d.feels}</p>`);
  screens.forEach(s => w(s.n, s.title, `<h1 style="font-size:32px;margin:0 0 16px">${s.title}</h1><p style="max-width:760px">${d.name}, screen ${s.n}. A neutral example board for the answer page template.</p>${s.n < 3 ? btn(`${k}${s.n + 1}`, "Next screen", d.c) : ""}`));
  w(4, "States", `<h1 style="font-size:32px;margin:0 0 16px">States</h1><p>Loading, error and offline for ${d.name}.</p>`);
}
const round = { id: "r1", n: 1, of: 3, steps: ["R1 Adding", "R2 The look", "Handoff"], project: { name: "Notes app", sub: "Design process · Example round" },
  title: "How should adding a note work?", lede: "**Every screen is a live prototype.** Click through each screen in A, B and C, pick one under each screen, then send. Nothing is sent until you press Send.",
  decided: ["Notes live in lists", "Phone and desktop share one layout"], thisRound: ["A, B or C for each of three screens"], next: ["The look: type, colour, density"],
  dirs: Object.fromEntries(Object.entries(dirs).map(([k, { c, ...d }]) => [k, d])), order: ["A", "B", "C"],
  scores: { criteria: ["Fits the main task", "Clarity", "Cost to build"], rows: { A: [5, 6, 7], B: [6, 6, 5], C: [5, 4, 3] }, overall: { A: 5, B: 6, C: 4.5 }, note: "Mean of the two reviewers. Overall is Claude's judgement." },
  screens: screens.map(s => ({ ...s, rev: "B" + s.n, opts: { A: "Quick add, screen " + s.n, B: "Add sheet, screen " + s.n, C: "Type anything, screen " + s.n }, fixes: { A: 2, B: 3, C: 2 } })),
  recommend: { label: "Take the recommendation: B on all three", text: "Recommendation: B on all three. Both reviewers rank B first.", picks: { 1: "B", 2: "B", 3: "B" } },
  heights, revisions: {}, decisions: [] };
fs.writeFileSync(path.join(out, "round.json"), JSON.stringify(round, null, 1) + "\n");
