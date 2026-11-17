// Publishes tickets and blocked-by links, plus an epic, sub-issues, milestones and a Project when configured; see references/tickets.md.
// node publish-issues.mjs <dir> check|run. Progress lives in <dir>/state.json, so a rerun resumes.
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [dir, mode = 'check'] = process.argv.slice(2);
if (!['check', 'run'].includes(mode)) throw new Error(`mode must be check or run, not ${mode}`);
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const { repo: REPO, owner: OWNER } = cfg;
const statePath = path.join(dir, 'state.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { img: {}, issues: {} };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
const gh = (args, input) => execFileSync('gh', args, { input, encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
const msOf = (t) => Object.values(cfg.milestones ?? {}).find(([, ts]) => ts.includes(t))?.[0];

const parse = (f, t) => {
  const [l1, l2, ...rest] = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
  if (!l1.startsWith('# ') || !l2.startsWith('labels:')) throw new Error(`${f}: line 1 must be "# title", line 2 "labels: ..."`);
  return { t, file: f, title: l1.slice(2).trim(), labels: l2.slice(7).split(',').map((s) => s.trim()).filter(Boolean), body: rest.join('\n').trim() };
};
const tickets = fs.readdirSync(dir).filter((f) => /^T\d\d-.*\.md$/.test(f)).sort().map((f) => parse(f, f.slice(1, 3)));
const hasEpic = fs.existsSync(path.join(dir, 'EPIC.md'));
const all = [...(hasEpic ? [parse('EPIC.md', 'EPIC')] : []), ...tickets];

let bad = 0;
const flag = (m) => { console.log(m); bad++; };
for (const x of all) {
  for (const m of x.body.matchAll(/\{\{IMG:([^|}]+)\|([^|}]*)\|(\d+)\}\}/g)) if (!fs.existsSync(m[1])) flag(`${x.file}: missing image ${m[1]}`);
  for (const m of x.body.matchAll(/\{\{IMG:[^}]*\}\}/g)) if (!/^\{\{IMG:[^|}]+\|[^|}]*\|\d+\}\}$/.test(m[0])) flag(`${x.file}: malformed ${m[0]}, want {{IMG:/abs/path.png|alt|width}}`);
  for (const m of x.body.matchAll(/\{\{(?!IMG:|EPIC\}\}|T:\d\d\}\})[^}]*\}\}/g)) flag(`${x.file}: unknown placeholder ${m[0]}`);
  if (!hasEpic && x.body.includes('{{EPIC}}')) flag(`${x.file}: {{EPIC}} but no EPIC.md`);
  for (const m of x.body.matchAll(/\{\{T:(\d\d)\}\}/g)) if (!tickets.some((k) => k.t === m[1])) flag(`${x.file}: no ticket T${m[1]}`);
  if (x.body.length > 65000) flag(`${x.file}: body ${x.body.length} chars > 65000 (GitHub's limit)`);
  if (x.t !== 'EPIC' && cfg.milestones && !msOf(x.t)) flag(`${x.file}: in no milestone`);
}
console.log(`${tickets.length} tickets, ${bad} problems`);
if (mode !== 'run' || bad) process.exit(bad ? 1 : 0);

for (const [title] of Object.values(cfg.milestones ?? {})) {
  const have = JSON.parse(gh(['api', `repos/${REPO}/milestones?state=all&per_page=100`]));
  if (!have.some((m) => m.title === title)) gh(['api', `repos/${REPO}/milestones`, '-f', `title=${title}`]);
}
const labels = new Set(JSON.parse(gh(['label', 'list', '-R', REPO, '-L', '500', '--json', 'name'])).map((l) => l.name));
for (const l of new Set(all.flatMap((x) => x.labels))) if (!labels.has(l)) gh(['label', 'create', l, '-R', REPO]);

for (const p of new Set(all.flatMap((x) => [...x.body.matchAll(/\{\{IMG:([^|}]+)\|/g)].map((m) => m[1])))) if (!state.img[p]) {
  if (!cfg.upload) throw new Error('images need config.upload (a command that prints the hosted URL)');
  const url = execSync(cfg.upload.replace('{path}', JSON.stringify(p)).replace('{repo}', REPO), { encoding: 'utf8' }).trim().split('\n').pop();
  if (!url.startsWith('https://')) throw new Error(`upload ${p}: ${url}`);
  state.img[p] = url; save(); console.log('uploaded', path.basename(p));
}

for (const x of all) if (!state.issues[x.t]) {
  const args = ['issue', 'create', '-R', REPO, '--title', x.title, '--body', 'Body is being written.'];
  for (const l of x.labels) args.push('--label', l);
  if (x.t !== 'EPIC' && msOf(x.t)) args.push('--milestone', msOf(x.t));
  const url = gh(args), n = Number(url.split('/').pop());
  state.issues[x.t] = { n, id: Number(gh(['api', `repos/${REPO}/issues/${n}`, '--jq', '.id'])), url }; save();
  console.log('created', x.t, url);
}

const resolve = (b) => b
  .replace(/\{\{IMG:([^|}]+)\|([^|}]*)\|(\d+)\}\}/g, (_, p, alt, w) => `<img src="${state.img[p]}" alt="${alt.replace(/"/g, '&quot;')}" width="${w}">`)
  .replace(/\{\{EPIC\}\}/g, () => `#${state.issues.EPIC.n}`)
  .replace(/\{\{T:(\d\d)\}\}/g, (_, t) => `#${state.issues[t].n}`);
// A rerun must not overwrite an issue the owner has since edited, so each body is written once.
for (const x of all) if (!state.issues[x.t].body) {
  gh(['issue', 'edit', String(state.issues[x.t].n), '-R', REPO, '--body-file', '-'], resolve(x.body));
  state.issues[x.t].body = true; save();
}

if (hasEpic) {
  const E = state.issues.EPIC.n;
  const subs = JSON.parse(gh(['api', `repos/${REPO}/issues/${E}/sub_issues?per_page=100`])).map((s) => s.number);
  for (const x of tickets) if (!subs.includes(state.issues[x.t].n)) gh(['api', '-X', 'POST', `repos/${REPO}/issues/${E}/sub_issues`, '-F', `sub_issue_id=${state.issues[x.t].id}`]);
}
for (const x of tickets) {
  const want = [...(x.body.split('\n').find((l) => l.startsWith('Blocked by:')) ?? '').matchAll(/\{\{T:(\d\d)\}\}/g)].map((m) => m[1]);
  const have = JSON.parse(gh(['api', `repos/${REPO}/issues/${state.issues[x.t].n}/dependencies/blocked_by`])).map((i) => i.number);
  for (const t of want) if (!have.includes(state.issues[t].n)) gh(['api', '-X', 'POST', `repos/${REPO}/issues/${state.issues[x.t].n}/dependencies/blocked_by`, '-F', `issue_id=${state.issues[t].id}`]);
}

if (cfg.project) {
  if (!state.project) {
    const p = JSON.parse(gh(['project', 'create', '--owner', OWNER, '--title', cfg.project, '--format', 'json']));
    state.project = { number: p.number, url: p.url }; save();
    gh(['project', 'link', String(p.number), '--owner', OWNER, '--repo', REPO]);
  }
  const items = JSON.parse(gh(['project', 'item-list', String(state.project.number), '--owner', OWNER, '--format', 'json', '-L', '500'])).items.map((i) => i.content?.number);
  for (const x of all) if (!items.includes(state.issues[x.t].n)) gh(['project', 'item-add', String(state.project.number), '--owner', OWNER, '--url', state.issues[x.t].url]);
}
console.log('done', ...all.map((x) => state.issues[x.t].url), state.project?.url ?? '');
