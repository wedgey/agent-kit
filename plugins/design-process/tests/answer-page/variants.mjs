// node variants.mjs <outDir> : writes outDir/prefixed (keys PA/PB/PC) and outDir/single (one direction, no scores, no concept)
import fs from "node:fs"; import path from "node:path";
const ex = path.join(path.dirname(new URL(import.meta.url).pathname), "../../skills/design-process/assets/answer-page/example"), out = process.argv[2];
const map = { A: "PA", B: "PB", C: "PC" }, rk = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [map[k] || k, v]));
const r = JSON.parse(fs.readFileSync(ex + "/round.json"));
const p = { ...r, dirs: rk(r.dirs), order: r.order.map(k => map[k]), scores: { ...r.scores, rows: rk(r.scores.rows), overall: rk(r.scores.overall) },
  screens: r.screens.map(s => ({ ...s, opts: rk(s.opts), fixes: rk(s.fixes) })), recommend: { ...r.recommend, picks: Object.fromEntries(Object.entries(r.recommend.picks).map(([n, k]) => [n, map[k]])) },
  heights: Object.fromEntries(Object.entries(r.heights).map(([k, v]) => [map[k[0]] + k.slice(1), v])), clashes: r.clashes.map(c => ({ ...c, dir: map[c.dir] })) };
fs.mkdirSync(out + "/prefixed", { recursive: true }); fs.writeFileSync(out + "/prefixed/round.json", JSON.stringify(p));
for (const sub of ["boards", "thumbs", "full"]) { fs.mkdirSync(`${out}/prefixed/${sub}`, { recursive: true });
  for (const x of fs.readdirSync(`${ex}/${sub}`)) { let b = fs.readFileSync(`${ex}/${sub}/${x}`);
    if (sub === "boards") b = b.toString().replace(/data-goto="([ABC])(\d)"/g, (_, a, n) => `data-goto="${map[a]}${n}"`);
    fs.writeFileSync(`${out}/prefixed/${sub}/${map[x[0]]}${x.slice(1)}`, b); } }
const one = { ...r, order: ["A"], dirs: { A: r.dirs.A }, scores: undefined, concept: false, research: false, recommend: undefined, clashes: undefined,
  screens: r.screens.map(s => ({ ...s, opts: { A: s.opts.A }, fixes: { A: s.fixes.A } })) };
fs.mkdirSync(out + "/single", { recursive: true }); fs.writeFileSync(out + "/single/round.json", JSON.stringify(one));
for (const sub of ["boards", "thumbs", "full"]) fs.cpSync(`${ex}/${sub}`, `${out}/single/${sub}`, { recursive: true });
