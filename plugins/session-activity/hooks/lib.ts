import type { AgentRow, AgentStatusWord, BranchHealth, Orphan, ShellTask, TodoItem, TodoList, Verdict } from '../types'

export type ProcRow = { pid: number; ppid: number; pgid: number; cpu: number; rssKb: number; args: string }

export type TaskNotice = { taskId: string; status?: string; exitCode?: number; outputPath?: string }

export type AgentSnapshot = {
  id: string
  type: string
  description: string
  status: AgentStatusWord
  parentId?: string
  name?: string
}

const ACTIVE: readonly AgentStatusWord[] = ['pending', 'running', 'waiting', 'idle']
const KEEP_FINISHED_AGENTS = 20

export const isAgentActive = (status: AgentStatusWord) => ACTIVE.includes(status)

// `ps -A -o pid=,ppid=,pgid=,pcpu=,rss=,args=`: the same columns on procps and BSD ps.
export function parsePs(stdout: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m || m[4] === undefined || m[6] === undefined) continue
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      cpu: Number(m[4].replace(',', '.')),
      rssKb: Number(m[5]),
      args: m[6],
    })
  }
  return rows
}

const portOf = (address: string) => {
  const m = /:(\d+)$/.exec(address)
  return m ? Number(m[1]) : undefined
}

function addPort(map: Map<number, number[]>, pid: number, port: number) {
  const list = map.get(pid) ?? []
  if (!list.includes(port)) list.push(port)
  map.set(pid, list)
}

// `ss -ltnpH`: `LISTEN 0 511 *:3000 *:* users:(("node",pid=12,fd=21))`
export function parseSs(stdout: string): Map<number, number[]> {
  const map = new Map<number, number[]>()
  for (const line of stdout.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5) continue
    const port = portOf(cols[3] ?? '')
    if (port === undefined) continue
    for (const m of line.matchAll(/pid=(\d+)/g)) addPort(map, Number(m[1]), port)
  }
  return map
}

// `lsof -nP -iTCP -sTCP:LISTEN -Fpn`: a `p<pid>` line, then `n<addr>:<port>` lines.
export function parseLsof(stdout: string): Map<number, number[]> {
  const map = new Map<number, number[]>()
  let pid: number | undefined
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid !== undefined) {
      const port = portOf(line.slice(1))
      if (port !== undefined) addPort(map, pid, port)
    }
  }
  return map
}

// How the Bash tool spells a command inside its wrapper: `eval '<command>'`.
export const shQuote = (command: string) => `'${command.replaceAll("'", `'"'"'`)}'`

export function findTaskShell(
  rows: readonly ProcRow[],
  rootPid: number,
  command: string,
  taken: ReadonlySet<number>,
): ProcRow | undefined {
  const pattern = `eval ${shQuote(command)}`
  const matches = rows.filter(r => !taken.has(r.pid) && r.args.includes(pattern))
  const own = matches.filter(r => r.ppid === rootPid)
  if (own.length > 0) return own[0]
  // Another session may run the same command; only an unambiguous match is safe to claim.
  return own.length === 0 && rootPid === 0 && matches.length === 1 ? matches[0] : undefined
}

// `/proc/<pid>/stat`: the command may hold spaces and parens, so fields count from the last `)`.
export function parseProcStat(text: string): Map<number, number> {
  const ticks = new Map<number, number>()
  for (const line of text.split('\n')) {
    const close = line.lastIndexOf(')')
    if (close < 0) continue
    const pid = Number.parseInt(line, 10)
    const fields = line.slice(close + 2).split(' ')
    const utime = Number(fields[11])
    const stime = Number(fields[12])
    if (Number.isFinite(pid) && Number.isFinite(utime) && Number.isFinite(stime)) ticks.set(pid, utime + stime)
  }
  return ticks
}

const CLOCK_TICKS_PER_SECOND = 100

// CPU over the last interval, as top shows it: 100% is one core busy.
export function cpuSince(prev: ReadonlyMap<number, number>, next: ReadonlyMap<number, number>, pids: readonly number[], elapsedMs: number): number {
  if (elapsedMs <= 0) return 0
  let ticks = 0
  for (const pid of pids) {
    const before = prev.get(pid)
    const after = next.get(pid)
    if (before !== undefined && after !== undefined && after >= before) ticks += after - before
  }
  return (ticks / CLOCK_TICKS_PER_SECOND / (elapsedMs / 1000)) * 100
}

export function treeOf(rows: readonly ProcRow[], rootPid: number, pgid?: number): ProcRow[] {
  const children = new Map<number, ProcRow[]>()
  for (const r of rows) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r])
  const seen = new Set<number>()
  const out: ProcRow[] = []
  const queue = rows.filter(r => r.pid === rootPid || (pgid !== undefined && r.pgid === pgid))
  while (queue.length > 0) {
    const r = queue.shift()!
    if (seen.has(r.pid)) continue
    seen.add(r.pid)
    out.push(r)
    queue.push(...(children.get(r.pid) ?? []))
  }
  return out
}

export function findSessionRoot(rows: readonly ProcRow[], startPid: number): number {
  const byPid = new Map(rows.map(r => [r.pid, r]))
  let at = byPid.get(startPid)
  for (let hops = 0; at && hops < 8; hops++) {
    if (/(^|\/)claude(\s|$)|claude-code|\/claude\/versions\/[^/\s]+(\s|$)/.test(at.args)) return at.pid
    at = byPid.get(at.ppid)
  }
  return startPid
}

export function parseTaskNotifications(text: string): TaskNotice[] {
  const out: TaskNotice[] = []
  for (const block of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block[1] ?? '')?.[1]?.trim()
    const taskId = tag('task-id')
    if (!taskId) continue
    const exit = /exit code (-?\d+)/.exec(tag('summary') ?? '')
    out.push({
      taskId,
      status: tag('status'),
      exitCode: exit ? Number(exit[1]) : undefined,
      outputPath: tag('output-file'),
    })
  }
  return out
}

export const parseOutputPath = (text: string | undefined) =>
  text ? /Output is being written to:\s*(\S+?)\.?(\s|$)/.exec(text)?.[1] : undefined

// The Bash tool's own last line once a background command exits.
const EXIT_MARKER = /^\[exited with code (-?\d+)\]$/

export function exitCodeOf(line: string | undefined): number | undefined {
  const m = line === undefined ? null : EXIT_MARKER.exec(line)
  return m?.[1] === undefined ? undefined : Number(m[1])
}

export function readTail(text: string): { line?: string; exitCode?: number } {
  const lines = visibleLines(text)
  const exitCode = exitCodeOf(lines[lines.length - 1])
  if (exitCode !== undefined) lines.pop()
  return { line: lines[lines.length - 1], exitCode }
}

export function lastLine(text: string): string | undefined {
  const lines = visibleLines(text)
  return lines[lines.length - 1]
}

function visibleLines(text: string): string[] {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .split('\n')
    .map(l => l.split('\r').filter(Boolean).pop()?.trim() ?? '')
    .filter(Boolean)
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

// `claude-opus-5-5[1m]` -> `Opus 5.5`; `claude-haiku-4-5-20251001` -> `Haiku 4.5`.
export function formatModel(id: string): string {
  const bare = id.replace(/\[.*\]$/, '').replace(/^(.*\.)?anthropic\./, '').replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/[@:].*$/, '')
  const m = /^([a-z]+)-(\d+(?:-\d+)?)$/.exec(bare)
  if (!m || m[1] === undefined || m[2] === undefined) return bare
  return `${m[1][0]?.toUpperCase()}${m[1].slice(1)} ${m[2].replace('-', '.')}`
}

export const formatEffort = (effort: string | number | undefined) => (effort === undefined ? undefined : String(effort))

export const formatTokens = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`)

export const formatMemory = (kb: number) => (kb < 1024 * 1024 ? `${Math.round(kb / 1024)}MB` : `${(kb / 1024 / 1024).toFixed(1)}GB`)

const PATH_ALIASES: readonly (readonly [RegExp, string])[] = [
  [/\/(?:var\/)?tmp\/claude-\d+\/[^/\s'"]+\/[0-9a-f-]{36}\/scratchpad\//g, 'scratch/'],
  [/\/(?:var\/)?tmp\/claude-\d+\/[^/\s'"]+\/[0-9a-f-]{36}\/tasks\//g, 'tasks/'],
  [/(?:\/[^\s'"/]+)*\/\.worktrees\//g, ''],
  [/\/home\/[^/\s'"]+\//g, '~/'],
]

export function shortenPaths(text: string): string {
  return PATH_ALIASES.reduce((out, [pattern, alias]) => out.replace(pattern, alias), text)
}

const WAIT_LOOP = /^\s*until\s+grep\s+-q\s+(['"]?)\^?(.+?)\1\s+([^\s;]+)/

// What a row calls a command when the call carried no description: one line, paths shortened.
export function summarizeCommand(command: string): string {
  const wait = WAIT_LOOP.exec(command)
  if (wait?.[2] !== undefined && wait[3] !== undefined) return `wait for ${wait[2]} in ${shortenPaths(wait[3])}`
  return shortenPaths(command.split('\n')[0] ?? '')
    .replace(/\s+(?:2>&1|2>\/dev\/null|<\s*\/dev\/null)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function summarizeToolUse(tool: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof input[k] === 'string') return input[k] as string
    return ''
  }
  const command = pick('command')
  let detail = command ? summarizeCommand(command) : pick('pattern', 'url', 'query', 'skill', 'description')
  const path = pick('file_path', 'path', 'notebook_path')
  if (path) detail = path.split('/').pop() ?? path
  detail = detail.split('\n')[0] ?? ''
  const line = detail ? `${tool}: ${detail}` : tool
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

export function mergeAgents(prev: readonly AgentRow[], list: readonly AgentSnapshot[], now: number): AgentRow[] {
  const listed = new Set(list.map(a => a.id))
  const rows: AgentRow[] = list.map(a => {
    const before = prev.find(p => p.id === a.id)
    return {
      ...a,
      firstSeenAt: before?.firstSeenAt ?? now,
      endedAt: isAgentActive(a.status) ? undefined : (before?.endedAt ?? now),
    }
  })
  for (const p of prev) {
    if (listed.has(p.id)) continue
    rows.push(isAgentActive(p.status) ? { ...p, status: 'completed', endedAt: p.endedAt ?? now } : p)
  }
  const finished = rows.filter(r => !isAgentActive(r.status)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  const dropped = new Set(finished.slice(KEEP_FINISHED_AGENTS).map(r => r.id))
  return rows.filter(r => !dropped.has(r.id))
}

export function orphansOf(rows: readonly ProcRow[], task: ShellTask, ports: Map<number, number[]>): Orphan[] {
  if (task.pgid === undefined) return []
  return rows
    .filter(r => r.pid !== task.shellPid && (r.pgid === task.pgid || (task.pids.includes(r.pid) && r.ppid === 1)))
    .map(r => ({ pid: r.pid, args: r.args, ports: ports.get(r.pid) ?? [], taskId: task.id, command: task.command }))
}

// A scan's results onto the list as it is now: a row cleared meanwhile stays gone,
// one added stays, and one ended meanwhile keeps its end.
export function mergeScan(current: readonly ShellTask[], scanned: readonly ShellTask[]): ShellTask[] {
  const byId = new Map(scanned.map(s => [s.id, s]))
  return current.map(s => {
    const n = byId.get(s.id)
    if (!n) return s
    return s.status === 'running' ? n : { ...s, pids: n.pids, shellPid: s.shellPid ?? n.shellPid, pgid: s.pgid ?? n.pgid }
  })
}

const EXPIRES: readonly ShellTask['status'][] = ['completed', 'killed', 'exited']

export function expireFinished(list: readonly ShellTask[], now: number, afterMs: number): ShellTask[] {
  if (afterMs <= 0) return [...list]
  return list.filter(s => !(EXPIRES.includes(s.status) && s.endedAt !== undefined && now - s.endedAt >= afterMs))
}

export function reconcileRunning(list: readonly ShellTask[], liveIds: ReadonlySet<string>, now: number): ShellTask[] {
  return list.map(s => (s.status === 'running' && !liveIds.has(s.id) ? { ...s, status: 'exited', endedAt: now, ports: [], cpu: 0 } : s))
}

export const usageTokens = (u: {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}) => u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

const TODO_STATUSES: readonly string[] = ['pending', 'in_progress', 'completed', 'skipped']

export type TodoInput = { title?: string; link?: string; items: Pick<TodoItem, 'content' | 'status' | 'note' | 'ticket'>[] }

export function todoInputError(input: Record<string, unknown>): string | undefined {
  if (!Array.isArray(input.items)) return '`items` must be an array of { content, status, note? }'
  for (const [i, item] of input.items.entries()) {
    if (typeof item?.content !== 'string' || item.content.trim() === '') return `items[${i}].content must be non-empty text`
    if (!TODO_STATUSES.includes(item.status)) return `items[${i}].status must be one of ${TODO_STATUSES.join(', ')}`
    if (item.ticket !== undefined && typeof item.ticket !== 'string') return `items[${i}].ticket must be text, as #123, owner/repo#123 or a URL`
  }
  return undefined
}

export function applyTodos(prev: TodoList | undefined, input: TodoInput, now: number): TodoList {
  const items = input.items.map(({ content, status, note, ticket }) => {
    const startedAt = status === 'pending' ? undefined : (prev?.items.find(p => p.content === content)?.startedAt ?? (status === 'in_progress' ? now : undefined))
    return { content, status, ...(note ? { note } : {}), ...(ticket ? { ticket } : {}), ...(startedAt === undefined ? {} : { startedAt }) }
  })
  const title = input.title ?? prev?.title
  const link = input.link ?? prev?.link
  return { ...(title ? { title } : {}), ...(link ? { link } : {}), items }
}

export function currentItem(list: TodoList): TodoItem | undefined {
  const active = list.items.filter(i => i.status === 'in_progress')
  return active.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
}

export const currentTodo = (list: TodoList) => currentItem(list)?.content

export function groupTodos<T extends Pick<TodoItem, 'status'>>(items: readonly T[]) {
  return {
    now: items.filter(i => i.status === 'in_progress'),
    next: items.filter(i => i.status === 'pending'),
    done: items.filter(i => i.status === 'completed' || i.status === 'skipped'),
  }
}

// `owner/repo` of a GitHub URL: an issue link, or a remote over https or ssh.
export const repoOf = (url: string | undefined) => {
  const m = url === undefined ? null : /github\.com[/:](?!(?:orgs|users|enterprises)\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/.exec(url)
  return m ? `${m[1]}/${m[2]}` : undefined
}

// The repo a bare `#N` belongs to: the list link's when it is an issue or PR, else the branch's origin.
export const contextRepo = (link: string | undefined, branchRepo: string | undefined) =>
  (link && /github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+/.test(link) ? repoOf(link) : undefined) ?? branchRepo

export type Ticket = { label: string; href?: string }

// A leading `#12`, `owner/repo#12`, or a GitHub issue or PR URL. An owner-less `name#12` is no ticket, so `C#9` stays text.
// shortcut: a leading `#1 priority` still reads as ticket #1; require the `ticket` field if that bites.
const TICKET = /^(?:https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)\S*|(?:([\w.-]+)\/([\w.-]+))?#(\d+)\b)/

function readTicket(text: string, repo: string | undefined): { ticket: Ticket; length: number } | undefined {
  const m = TICKET.exec(text)
  if (!m) return undefined
  const [ctxOwner, ctxName] = repo?.split('/') ?? []
  const owner = m[1] ?? m[5] ?? ctxOwner
  const name = m[2] ?? m[6] ?? ctxName
  const n = m[4] ?? m[7]
  const label = !name || (name === ctxName && owner === ctxOwner) ? `#${n}` : `${name}#${n}`
  const href = owner && name ? `https://github.com/${owner}/${name}/${m[3] ?? 'issues'}/${n}` : undefined
  return { ticket: { label, ...(href ? { href } : {}) }, length: m[0].length }
}

// An item's ticket (its `ticket` field, else one leading its text) and the text left to show.
export function ticketOf(item: Pick<TodoItem, 'content' | 'ticket'>, repo?: string): { ticket?: Ticket; text: string } {
  const lead = readTicket(item.content, repo)
  const raw = item.ticket?.trim()
  const given = raw ? (readTicket(raw, repo)?.ticket ?? (/^https?:\/\//.test(raw) ? urlTicket(raw) : { label: raw })) : undefined
  const ticket = given ?? lead?.ticket
  const text = lead && (!given || lead.ticket.label === given.label) ? item.content.slice(lead.length).replace(/^[\s:·—–-]+/, '') : item.content
  return { ...(ticket ? { ticket } : {}), text }
}

// A ticket URL GitHub's forms miss (Linear, Jira, a discussion): its last path segment links to it.
const urlTicket = (url: string): Ticket => ({ label: url.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() ?? url, href: url })

export function todoTitle(item: Pick<TodoItem, 'content' | 'ticket'>, repo?: string): string {
  const { ticket, text } = ticketOf(item, repo)
  return ticket ? `${ticket.label} ${text}` : text
}

// The report shape conductor's delegates end with: `STATUS  PASS | ISSUES | BLOCKED`, or a verifier's FAIL.
export const parseVerdict = (answer: string) =>
  /^[*_\s]*STATUS[*_:\s]+(PASS\+NOTES|PASS|ISSUES|BLOCKED|FAIL)\b/m.exec(answer)?.[1] as Verdict | undefined

export function parseAgentDef(text: string): { model?: string; effort?: string; isReadOnly: boolean } {
  const lines = (/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '').split(/\r?\n/)
  // A value on the key's own line, or a YAML list on the lines below it.
  const field = (name: string) => {
    const at = lines.findIndex(l => l.startsWith(`${name}:`))
    if (at < 0) return undefined
    const inline = lines[at]!.slice(name.length + 1).trim()
    if (inline) return inline
    const items: string[] = []
    for (const l of lines.slice(at + 1)) {
      const m = /^\s*-\s*(.+)$/.exec(l)
      if (!m) break
      items.push(m[1]!.trim())
    }
    return items.length > 0 ? items.join(', ') : undefined
  }
  const model = field('model')
  const effort = field('effort')
  const tools = field('tools')
  const isReadOnly = /\b(Edit|Write)\b/.test(field('disallowedTools') ?? '') || (tools !== undefined && !/\b(Edit|Write)\b|\*/.test(tools))
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), isReadOnly }
}

export const agentName = (text: string) =>
  /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '')?.[1]

type PluginInstall = { scope?: string; projectPath?: string; installPath?: string }

// installed_plugins.json: `{ plugins: { "<plugin>@<marketplace>": [install, ...] } }`; an older file holds one install, not a list.
export function pluginInstallPath(installed: unknown, plugin: string, cwd: string): string | undefined {
  const plugins = (installed as { plugins?: Record<string, PluginInstall | PluginInstall[]> } | null)?.plugins ?? {}
  const installs = Object.entries(plugins)
    .filter(([key]) => key.slice(0, key.lastIndexOf('@')) === plugin || key === plugin)
    .flatMap(([, v]) => [v].flat())
  const inProject = installs.find(i => i.projectPath && (cwd === i.projectPath || cwd.startsWith(`${i.projectPath}/`)))
  return (inProject ?? installs.find(i => i.scope === undefined || i.scope === 'user'))?.installPath
}

// Where a plugin's agents live, relative to its root: `agents/` always, plus each `./` file or folder its manifest lists.
// The caller still checks where each lands, as a symbolic link can lead out of the root.
export function pluginAgentPaths(manifest: unknown): string[] {
  const listed = [(manifest as { agents?: unknown } | null)?.agents ?? []].flat().filter((p): p is string => typeof p === 'string')
  const inside = listed.filter(p => p.startsWith('./') && !p.split('/').includes('..'))
  return ['agents', ...inside.map(p => p.slice(2).replace(/\/$/, ''))]
}

export const modelMatches = (want: string, ran: string) => want === 'inherit' || ran.includes(want)

export const porcelainLines = (stdout: string) => stdout.split('\n').filter(Boolean)

export const newChanges = (before: readonly string[], stdout: string) => porcelainLines(stdout).filter(l => !before.includes(l)).length

// BRANCH_SCRIPT's five lines: branch, trunk, commits behind trunk, changed files, origin's URL.
export const BRANCH_SCRIPT =
  'b=$(git rev-parse --abbrev-ref HEAD) || exit 1; t=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null) || t=origin/main; ' +
  'echo "$b"; echo "$t"; git rev-list --count "HEAD..$t" 2>/dev/null || echo; git status --porcelain | wc -l; git remote get-url origin 2>/dev/null'

export function parseBranch(stdout: string): BranchHealth | undefined {
  const [branch, trunk, behind, changed, remote] = stdout.split('\n').map(l => l.trim())
  if (!branch) return undefined
  const repo = repoOf(remote)
  return { branch, ...(trunk ? { trunk } : {}), ...(behind ? { behind: Number(behind) } : {}), changed: Number(changed) || 0, ...(repo ? { repo } : {}) }
}
