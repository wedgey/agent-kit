// Render canvas boards to full-height PNGs at 1440 wide, plus what reviewers read:
// <out>/review/<Board>-<n>.png, the board in 1200px-tall tiles at 0.6 scale (864x720, about a third of the
// image tokens per area of a 1440x900 shot), and <out>/sheets/<Prefix>-<k>.png, contact sheets of 8 boards per prefix,
// each cell cropped to the board's top 2400px so a sheet stays under the ~1568px read limit.
// Prints `overflow <Board> <rendered h> > <board h>` for a board taller than its canvas.json height, and exits 1.
// Image readers shrink anything over ~1568px on its long edge, so a tall board read whole is unreadable: read tiles.
// node render.cjs <project dir> <out dir> <Board.dc.html ...> [--blobs blobs.json --shots dir1,dir2]
// Playwright is resolved from the current repo (run from its root), or from PLAYWRIGHT_PATH.
const fs = require('fs'), path = require('path'), { createRequire } = require('module');
const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i < 0 ? null : args.splice(i, 2)[1]; };
const blobsFile = opt('--blobs'), shotDirs = (opt('--shots') || '').split(',').filter(Boolean);
const [dir, out, ...files] = args;
const roots = [process.cwd(), ...(fs.existsSync('apps') ? fs.readdirSync('apps').map((d) => path.resolve('apps', d)) : [])];
const { chromium } = require(process.env.PLAYWRIGHT_PATH || createRequire(__filename).resolve('@playwright/test', { paths: roots }));
// /_blob/<hash> only exists on the artifact server: serve the local copy named in blobs.json ({name: "/_blob/<hash>"})
const blob = {};
if (blobsFile) for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(blobsFile, 'utf8')))) {
  const hit = shotDirs.flatMap((d) => ['.jpg', '.png'].map((x) => path.join(d, k + x))).find(fs.existsSync);
  if (hit) blob[v.split('/').pop()] = hit;
}
const name = (f) => path.basename(f).replace('.dc.html', '');
const prefix = (n) => (n.match(/^[A-Za-z]+/) || ['Board'])[0];
const layout = fs.existsSync(path.join(dir, 'canvas.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'canvas.json'), 'utf8')).boards || {} : {};
let overflow = 0;
(async () => {
  const review = path.join(out, 'review'), sheets = path.join(out, 'sheets');
  for (const d of [out, review, sheets]) fs.mkdirSync(d, { recursive: true });
  const b = await chromium.launch();
  const full = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const small = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 0.6 });
  const TILE = 1200;
  for (const f of files) {
    let miss = 0;
    for (const f2 of fs.readdirSync(review).filter((x) => x.startsWith(name(f) + '-') && /^-\d+\.png$/.test(x.slice(name(f).length)))) fs.unlinkSync(path.join(review, f2));
    for (const ctx of [full, small]) {
      const p = await ctx.newPage();
      await p.route(/\/_blob\//, (r) => { const h = r.request().url().split('/').pop(); return blob[h] ? r.fulfill({ path: blob[h] }) : (miss++, r.abort()); });
      await p.goto('file://' + path.resolve(dir, f), { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => console.log('warn', f, e.message.split('\n')[0]));
      await p.waitForTimeout(600);
      if (ctx === full) await p.screenshot({ path: path.join(out, name(f) + '.png'), fullPage: true });
      else {
        const h = await p.evaluate(() => document.documentElement.scrollHeight);
        const want = layout[path.basename(f)]?.h;
        if (want && h > want + 1) { overflow++; console.log('overflow', name(f), h, '>', want); }
        for (let y = 0, n = 0; y < h; y += TILE, n++)
          await p.screenshot({ path: path.join(review, `${name(f)}-${n}.png`), fullPage: true, clip: { x: 0, y, width: 1440, height: Math.min(TILE, h - y) } });
      }
      await p.close();
    }
    if (miss) console.log('missing blobs', f, miss / 2);
  }
  // A sheet holds every full-size board of its prefix on disk, not only this run's, so it stays whole after a partial re-render.
  const groups = {};
  // Only boards whose source still exists, so a renamed or deleted board drops off its sheet.
  for (const f of fs.readdirSync(out).filter((x) => x.endsWith('.png') && fs.existsSync(path.join(dir, x.replace('.png', '.dc.html')))).sort()) (groups[prefix(f)] ||= []).push(f);
  const touched = new Set(files.map((f) => prefix(name(f))));
  const p = await full.newPage();
  for (const f of fs.readdirSync(sheets).filter((x) => touched.has(x.replace(/-\d+\.png$/, '')))) fs.unlinkSync(path.join(sheets, f));
  for (const [g, all] of Object.entries(groups)) {
    if (!touched.has(g)) continue;
    for (let k = 0; k * 8 < all.length; k++) {
    const shots = all.slice(k * 8, k * 8 + 8), sheet = `${g}-${k}`;
    const cells = shots.map((s) => `<figure><img src="../${s}"><figcaption>${s.replace('.png', '')}</figcaption></figure>`).join('');
    const html = path.join(sheets, sheet + '.html');
    fs.writeFileSync(html, `<style>body{margin:0;padding:16px;background:#e5e5e5;font:600 18px system-ui;display:grid;grid-template-columns:repeat(4,1fr);gap:16px;align-items:start}figure{margin:0}img{width:100%;aspect-ratio:1440/2400;object-fit:cover;object-position:top;display:block;background:#fff}figcaption{padding:6px 0}</style>${cells}`);
    await p.goto('file://' + html, { waitUntil: 'load' });
    await p.screenshot({ path: path.join(sheets, sheet + '.png'), fullPage: true });
    fs.unlinkSync(html);
    }
  }
  await b.close();
  console.log('rendered', files.length, 'review', review, 'sheets', [...touched].join(','), 'overflow', overflow);
  process.exitCode = overflow ? 1 : 0;
})();
