// node variants.mjs <outDir> : writes outDir/prefixed (keys PA/PB/PC), outDir/single (one direction, no scores, no concept) and outDir/many (ten screens)
import fs from "node:fs"; import path from "node:path";
const ex = path.join(path.dirname(new URL(import.meta.url).pathname), "../../skills/design-process/assets/answer-page/example"), out = process.argv[2];
const map = { A: "PA", B: "PB", C: "PC" }, rk = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [map[k] || k, v]));
const r = JSON.parse(fs.readFileSync(ex + "/round.json"));
const p = { ...r, dirs: rk(r.dirs), order: r.order.map(k => map[k]), scores: { ...r.scores, rows: rk(r.scores.rows), overall: rk(r.scores.overall) },
  screens: r.screens.map(s => ({ ...s, opts: rk(s.opts), fixes: rk(s.fixes) })), recommend: { ...r.recommend, picks: Object.fromEntries(Object.entries(r.recommend.picks).map(([n, k]) => [n, map[k]])) },
  heights: Object.fromEntries(Object.entries(r.heights).map(([k, v]) => [map[k[0]] + k.slice(1), v])), clashes: (r.clashes || []).map(c => ({ ...c, dir: map[c.dir] })) };
fs.mkdirSync(out + "/prefixed", { recursive: true }); fs.writeFileSync(out + "/prefixed/round.json", JSON.stringify(p));
for (const sub of ["boards", "thumbs", "full"]) { fs.mkdirSync(`${out}/prefixed/${sub}`, { recursive: true });
  for (const x of fs.readdirSync(`${ex}/${sub}`)) { let b = fs.readFileSync(`${ex}/${sub}/${x}`);
    if (sub === "boards") b = b.toString().replace(/data-goto="([ABC])(\d)"/g, (_, a, n) => `data-goto="${map[a]}${n}"`);
    fs.writeFileSync(`${out}/prefixed/${sub}/${map[x[0]]}${x.slice(1)}`, b); } }
const one = { ...r, order: ["A"], dirs: { A: r.dirs.A }, scores: undefined, concept: false, research: false, recommend: undefined, clashes: undefined,
  screens: r.screens.map(s => ({ ...s, opts: { A: s.opts.A }, fixes: { A: s.fixes.A } })) };
fs.mkdirSync(out + "/single", { recursive: true }); fs.writeFileSync(out + "/single/round.json", JSON.stringify(one));
for (const sub of ["boards", "thumbs", "full"]) fs.cpSync(`${ex}/${sub}`, `${out}/single/${sub}`, { recursive: true });
// outDir/many: ten screens, so the screen numbers 10 and the states board 11 have two digits.
const N = 10, ks = r.order;
const many = { ...r, screens: Array.from({ length: N }, (_, i) => { const s = r.screens[i % r.screens.length]; return { ...s, n: i + 1, title: `${s.title} ${i + 1}` }; }),
  recommend: { ...r.recommend, picks: { 1: "A", 10: "B" } }, clashes: [],
  heights: Object.fromEntries(ks.flatMap((k) => Array.from({ length: N + 2 }, (_, n) => [`${k}${n}`, r.heights[`${k}1`]]))) };
fs.mkdirSync(out + "/many", { recursive: true }); fs.writeFileSync(out + "/many/round.json", JSON.stringify(many));
for (const sub of ["boards", "thumbs", "full"]) { fs.mkdirSync(`${out}/many/${sub}`, { recursive: true });
  for (const k of ks) for (let n = 0; n <= N + 1; n++) {
    const src = n === 0 ? 0 : n === N + 1 ? r.screens.length + 1 : ((n - 1) % r.screens.length) + 1, ext = sub === "boards" ? "html" : "jpg";
    fs.copyFileSync(`${ex}/${sub}/${k}${src}.${ext}`, `${out}/many/${sub}/${k}${n}.${ext}`); } }
