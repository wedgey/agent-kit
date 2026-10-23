import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentMetrics, AgentRow, Orphan, ShellTask, SpawnInfo, TodoItem, TodoStatus, Verdict } from '../types'
import {
  agentName,
  applyTodos,
  BRANCH_SCRIPT,
  cpuSince,
  currentItem,
  currentTodo,
  groupTodos,
  pluginAgentPaths,
  pluginInstallPath,
  repoOf,
  ticketOf,
  todoTitle,
  modelMatches,
  newChanges,
  parseAgentDef,
  parseBranch,
  parseVerdict,
  porcelainLines,
  todoInputError,
  type TodoInput,
  exitCodeOf,
  expireFinished,
  findSessionRoot,
  findTaskShell,
  formatDuration,
  formatEffort,
  formatMemory,
  formatModel,
  formatTokens,
  isAgentActive,
  mergeAgents,
  mergeScan,
  orphansOf,
  parseLsof,
  parseOutputPath,
  parseProcStat,
  parsePs,
  parseSs,
  parseTaskNotifications,
  readTail,
  shortenPaths,
  summarizeCommand,
  reconcileRunning,
  summarizeToolUse,
  treeOf,
  usageTokens,
  type ProcRow,
} from './lib'

const P = 'session-activity'
const PANE = 'session-activity'
const TICK_MS = 2000
const CONFIRM_MS = 4000
const NARROW_COLUMNS = 46
const MONITOR_GROUP = 'group:stopped-monitors'
const KILL_GRACE_MS = 3000
// Survivors of an ended task's process group count as orphans only inside this window:
// earlier they may still be shutting down, later the pgid may have been reused.
const ORPHAN_WINDOW: readonly [number, number] = [3000, 15000]

const agentsA = atom({ plugin: 'session-activity', key: 'agents' } as const, [])
const metricsA = atom({ plugin: 'session-activity', key: 'metrics' } as const, {})
const shellsA = atom({ plugin: 'session-activity', key: 'shells' } as const, [])
const orphansA = atom({ plugin: 'session-activity', key: 'orphans' } as const, [])
const confirmA = atom({ plugin: 'session-activity', key: 'confirm' } as const, '')
const expandedA = atom({ plugin: 'session-activity', key: 'expanded' } as const, [])
const rootPidA = atom({ plugin: 'session-activity', key: 'rootPid' } as const, 0)
const todosA = atom({ plugin: 'session-activity', key: 'todos' } as const, { items: [] })
// shortcut: spawn records are never pruned; drop them with mergeAgents' cap if long sessions grow the state.
const spawnsA = atom({ plugin: 'session-activity', key: 'spawns' } as const, {})
const branchA = atom({ plugin: 'session-activity', key: 'branch' } as const, { branch: '', changed: 0 })
const spendA = atom({ plugin: 'session-activity', key: 'spend' } as const, {})

const TODO_TOOL = 'todos'
const TODO_TOOL_CALL = /^mcp__session-activity__todos$/
const GH_TIMEOUT_MS = 3000
const BRANCH_EVERY_MS = 30_000
const PR_EVERY_MS = 300_000
const TODO_ICON: Record<TodoStatus, { glyph: string; color: string }> = {
  completed: { glyph: '✓', color: 'success' },
  in_progress: { glyph: '◐', color: 'suggestion' },
  pending: { glyph: '○', color: 'inactive' },
  skipped: { glyph: '–', color: 'inactive' },
}
const VERDICT_COLOR: Record<Verdict, string> = { PASS: 'success', 'PASS+NOTES': 'success', ISSUES: 'warning', BLOCKED: 'warning', FAIL: 'error' }
const TODO_DESCRIPTION = [
  'Your todo list for the current task, drawn for the user in the session-activity pane beside the chat.',
  'Use it wherever your instructions say to track steps in a todo list. Each call replaces the whole list.',
  'Mark an item in_progress when you start it and completed as soon as it is done; an item that ships a PR is done only once nothing but its merge queue is left. Never delete a step you will not do: mark it skipped with the reason in `note`.',
  'Start an item with its ticket, as `#123 Fix the login redirect` (or `repo#9` for another repo), or pass it as `ticket`.',
  'Agents you spawn are listed under the item in progress when you spawn them.',
  '`title` heads the list (the kind of task, or the playbook it follows). `link` is the URL of the issue that holds the work state.',
].join(' ')
const TODO_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short heading, such as the playbook name' },
    link: { type: 'string', description: 'URL of the tracker issue for this work' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'skipped'] },
          note: { type: 'string', description: 'Why an item is skipped, or any short note' },
          ticket: { type: 'string', description: 'Issue or PR for this item, as #123, owner/repo#123 or a URL' },
        },
        required: ['content', 'status'],
      },
    },
  },
  required: ['items'],
}

type $ = EngineInterface

let onExit: 'stop' | 'leave' = 'stop'
let notifyAfterMs = 30_000
let quietMs = 300_000
let clearAfterMs = 120_000
let lastTicks: { at: number; ticks: Map<number, number> } | undefined
let isTicking = false
let isDismissed = false
let tasksDir: string | undefined
// PreToolUse hooks (rtk) may rewrite a command; the shell runs the rewrite, so that is what ps shows.
const ranCommands = new Map<string, string>()
const agentCalls = new Map<string, { effort?: string; isolation?: string }>()
let branchAt = 0
let prLookup: { branch: string; at: number; pr?: number } | undefined

const metricsOf = async ($: $, id: string, fn: (m: AgentMetrics) => AgentMetrics) =>
  update($, metricsA, all => ({ ...all, [id]: fn(all[id] ?? { toolUses: 0, tokens: 0, activity: [] }) }))

const patchShell = ($: $, id: string, fn: (s: ShellTask) => ShellTask) =>
  update($, shellsA, list => list.map(s => (s.id === id ? fn(s) : s)))

async function cpuTicks($: $, pids: readonly number[]): Promise<Map<number, number> | undefined> {
  if (pids.length === 0) return new Map()
  try {
    const stat = await $.process.run(['cat', ...pids.map(pid => `/proc/${pid}/stat`)])
    const ticks = parseProcStat(stat.stdout)
    return ticks.size > 0 ? ticks : undefined
  } catch {
    return undefined
  }
}

async function sessionRoot($: $): Promise<number> {
  const out = await $.process.run(['sh', '-c', 'echo "self $$"; ps -A -o pid=,ppid=,pgid=,pcpu=,rss=,args='])
  const self = Number(/^self (\d+)/.exec(out.stdout)?.[1])
  return Number.isFinite(self) ? findSessionRoot(parsePs(out.stdout), self) : 0
}

async function processTable($: $): Promise<ProcRow[]> {
  const ps = await $.process.run(['ps', '-A', '-o', 'pid=,ppid=,pgid=,pcpu=,rss=,args='])
  return parsePs(ps.stdout)
}

async function listeningPorts($: $): Promise<Map<number, number[]>> {
  try {
    const ss = await $.process.run(['ss', '-ltnpH'])
    if (ss.exitCode === 0) return parseSs(ss.stdout)
  } catch {}
  try {
    const lsof = await $.process.run(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'])
    return parseLsof(lsof.stdout)
  } catch {
    return new Map()
  }
}

async function tailOf($: $, path: string) {
  try {
    const tail = await $.process.run(['tail', '-c', '4096', path])
    return tail.stdout
  } catch {
    return ''
  }
}

type AgentDef = ReturnType<typeof parseAgentDef>
const pluginAgentDefs = new Map<string, Promise<AgentDef>>()

const configDir = async ($: $) => (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? '~'}/.claude`

async function agentDef($: $, type: string): Promise<AgentDef> {
  if (type === 'fork' || type.includes('/')) return { isReadOnly: false }
  if (type.includes(':')) {
    if (!pluginAgentDefs.has(type)) pluginAgentDefs.set(type, pluginAgentDef($, type))
    return pluginAgentDefs.get(type)!
  }
  const dirs = [`${await $.session.cwd()}/.claude/agents`, `${await configDir($)}/agents`]
  for (const dir of dirs) {
    try {
      return parseAgentDef(await $.fs.read(`${dir}/${type}.md`))
    } catch {}
  }
  return { isReadOnly: false }
}

// `<plugin>:<name>`: the installed plugin's agent files, matched by their frontmatter `name`.
// shortcut: a plugin loaded with --plugin-dir is not found, as no hook can list loaded plugins' folders.
async function pluginAgentDef($: $, type: string): Promise<AgentDef> {
  const plugin = type.slice(0, type.indexOf(':'))
  const name = type.slice(type.lastIndexOf(':') + 1)
  try {
    const installed: unknown = JSON.parse(await $.fs.read(`${await configDir($)}/plugins/installed_plugins.json`))
    const root = pluginInstallPath(installed, plugin, await $.session.cwd())
    if (!root) return { isReadOnly: false }
    const manifest: unknown = await $.fs.read(`${root}/.claude-plugin/plugin.json`).then(JSON.parse, () => ({}))
    for (const entry of pluginAgentPaths(manifest)) {
      const path = `${root}/${entry}`
      const files = path.endsWith('.md')
        ? [path]
        : await $.fs.list(path).then(list => list.filter(f => f.name.endsWith('.md')).map(f => `${path}/${f.name}`), () => [])
      for (const file of files) {
        const text = await $.fs.read(file).catch(() => '')
        if (agentName(text) === name) return parseAgentDef(text)
      }
    }
  } catch {}
  return { isReadOnly: false }
}

async function gitStatus($: $): Promise<string | undefined> {
  try {
    const out = await $.process.run(['git', 'status', '--porcelain'])
    return out.exitCode === 0 ? out.stdout : undefined
  } catch {
    return undefined
  }
}

async function refreshBranch($: $, now: number) {
  if (now - branchAt < BRANCH_EVERY_MS) return
  branchAt = now
  const out = await $.process.run(['sh', '-c', BRANCH_SCRIPT]).catch(() => undefined)
  const health = out?.exitCode === 0 ? parseBranch(out.stdout) : undefined
  if (!health) return
  if (prLookup?.branch !== health.branch || now - prLookup.at >= PR_EVERY_MS) {
    const pr = await $.process.run(['gh', 'pr', 'view', '--json', 'number', '-q', '.number'], { timeoutMs: GH_TIMEOUT_MS }).catch(() => undefined)
    const n = Number(pr?.stdout.trim())
    prLookup = { branch: health.branch, at: now, ...(pr?.exitCode === 0 && n > 0 ? { pr: n } : {}) }
  }
  await update($, branchA, () => ({ ...health, ...(prLookup?.pr ? { pr: prLookup.pr } : {}) }))
}

async function maybeOpen($: $) {
  if (isDismissed) return
  const panes = await $.ui.panes()
  if (!panes.some(p => p.id === PANE)) void $.ui.open({ id: PANE, title: 'Session activity' })
}

async function scan($: $, now: number) {
  const [rows, ports] = await Promise.all([processTable($), listeningPorts($)])
  const alive = new Set(rows.map(r => r.pid))
  let rootPid = await read($, rootPidA)
  if (!alive.has(rootPid)) {
    rootPid = await sessionRoot($).catch(() => 0)
    await update($, rootPidA, () => rootPid)
  }
  const shells = await read($, shellsA)
  const taken = new Set(shells.flatMap(s => (s.shellPid ? [s.shellPid] : [])))
  const found: Orphan[] = []
  const next: ShellTask[] = []
  const trees = new Map<string, number[]>()

  for (const s of shells) {
    let task = s
    if (task.status === 'running' && task.shellPid === undefined) {
      const shell = findTaskShell(rows, rootPid, task.shellCommand ?? task.command, taken)
      if (shell) {
        taken.add(shell.pid)
        task = { ...task, shellPid: shell.pid, pgid: shell.pgid }
      }
    }
    const shellPid = task.shellPid
    if (task.status === 'running' && shellPid !== undefined) {
      const tree = treeOf(rows, shellPid, task.pgid)
      task = {
        ...task,
        pids: [...new Set([...task.pids, ...tree.map(r => r.pid)])].slice(-64),
        ports: [...new Set(tree.flatMap(r => ports.get(r.pid) ?? []))].sort((a, b) => a - b),
        cpu: tree.reduce((sum, r) => sum + r.cpu, 0),
        rssKb: tree.reduce((sum, r) => sum + r.rssKb, 0),
      }
      task = { ...task, peakRssKb: Math.max(task.peakRssKb ?? 0, task.rssKb) }
      if (!alive.has(shellPid)) task = { ...task, status: 'exited', endedAt: now, ports: [], cpu: 0 }
    }
    if (task.status === 'running' && task.outputPath) {
      try {
        const stat = await $.fs.stat(task.outputPath)
        if (stat.size !== task.outputSize) {
          const tail = readTail(await tailOf($, task.outputPath))
          task = { ...task, outputSize: stat.size, lastOutputAt: now, lastLine: tail.line ?? task.lastLine }
          if (tail.exitCode !== undefined) task = endedTask(task, tail.exitCode === 0 ? 'completed' : 'failed', tail.exitCode, now)
        }
      } catch {}
    }
    const markerCode = exitCodeOf(task.lastLine)
    if (task.status === 'running' && markerCode !== undefined) {
      task = endedTask(task, markerCode === 0 ? 'completed' : 'failed', markerCode, task.lastOutputAt ?? now)
    }
    if (task.status === 'running' && task.shellPid !== undefined) trees.set(task.id, treeOf(rows, task.shellPid, task.pgid).map(r => r.pid))
    const sinceEnd = task.endedAt === undefined ? -1 : now - task.endedAt
    if (sinceEnd >= ORPHAN_WINDOW[0] && sinceEnd <= ORPHAN_WINDOW[1]) found.push(...orphansOf(rows, task, ports))
    next.push(task)
  }

  const ticks = await cpuTicks($, [...trees.values()].flat())
  if (ticks) {
    const prev = lastTicks
    lastTicks = { at: now, ticks }
    if (prev) {
      for (const task of next) {
        const pids = trees.get(task.id)
        if (pids) task.cpu = cpuSince(prev.ticks, ticks, pids, now - prev.at)
      }
    }
  }
  await update($, shellsA, list => mergeScan(list, next))
  for (const task of next.filter(t => t.status !== 'running' && !shells.find(s => s.id === t.id && s.status !== 'running'))) {
    await announceEnd($, task.id)
  }
  await update($, orphansA, list => {
    const kept = list.filter(o => alive.has(o.pid)).map(o => ({ ...o, ports: ports.get(o.pid) ?? [] }))
    const fresh = found.filter(o => !kept.some(k => k.pid === o.pid))
    return [...kept, ...fresh]
  })
}

function endedTask(task: ShellTask, status: ShellTask['status'], exitCode: number | undefined, at: number): ShellTask {
  return { ...task, status, exitCode: exitCode ?? task.exitCode, endedAt: task.endedAt ?? at, ports: [], cpu: 0 }
}

async function announceEnd($: $, id: string) {
  const task = (await read($, shellsA)).find(s => s.id === id)
  if (!task || task.isNotified || task.status === 'running' || task.status === 'killed' || task.endedAt === undefined) return
  if (notifyAfterMs <= 0 || task.endedAt - task.startedAt < notifyAfterMs) return
  await patchShell($, id, s => ({ ...s, isNotified: true }))
  const took = formatDuration(task.endedAt - task.startedAt)
  const name = task.description ?? task.command.split('\n')[0]
  void $.ui.notify(
    task.status === 'failed'
      ? `✗ ${name} failed${task.exitCode !== undefined ? ` (exit ${task.exitCode})` : ''} after ${took}`
      : `✓ ${name} finished in ${took}`,
    { title: 'Background task' },
  )
}

async function tick($: $) {
  if (isTicking) return
  isTicking = true
  try {
    const now = await $.clock.now()
    const list = await $.agent.list()
    await update($, agentsA, prev => mergeAgents(prev, list, now))
    await update($, shellsA, shells => expireFinished(shells, now, clearAfterMs))
    const shells = await read($, shellsA)
    const orphans = await read($, orphansA)
    const needsScan =
      orphans.length > 0 ||
      shells.some(s => s.status === 'running' || (s.endedAt !== undefined && now - s.endedAt <= ORPHAN_WINDOW[1]))
    if (needsScan) await scan($, now)
    if ((await read($, todosA)).items.length > 0) await refreshBranch($, now)
    await refreshStatus($)
  } finally {
    isTicking = false
  }
}

async function refreshStatus($: $) {
  const [agents, shells, orphans, todos, branch] = await Promise.all([read($, agentsA), read($, shellsA), read($, orphansA), read($, todosA), read($, branchA)])
  const running = shells.filter(s => s.status === 'running')
  const servers = running.filter(s => s.ports.length > 0).length
  const parts = [
    [agents.filter(a => isAgentActive(a.status)).length, 'agent'],
    [servers, 'server'],
    [running.length - servers, 'script'],
  ] as const
  const words = parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`)
  if (orphans.length > 0) words.push(`⚠ ${orphans.length} orphan${orphans.length === 1 ? '' : 's'}`)
  const done = todos.items.filter(i => i.status === 'completed' || i.status === 'skipped').length
  const now = currentItem(todos)
  const step = todos.items.length > 0 ? `◆ ${done}/${todos.items.length}${now ? ` ${todoTitle(now, repoOf(todos.link) ?? branch.repo)}` : ''}` : undefined
  const line = [step, words.length > 0 ? `⚙ ${words.join(' · ')}` : undefined].filter(Boolean).join('  ')
  $.ui.status(line || undefined)
}

async function killPids($: $, targets: string[]) {
  if (targets.length === 0) return
  await $.process.run(['kill', '-TERM', '--', ...targets]).catch(() => undefined)
  $.clock.after(KILL_GRACE_MS, () => {
    void $.process.run(['kill', '-KILL', '--', ...targets]).catch(() => undefined)
  })
}

async function stopShell($: $, id: string) {
  const task = (await read($, shellsA)).find(s => s.id === id)
  if (!task) return
  await $.tool
    .call({ tool: 'TaskStop', task_id: id, consent: `The user pressed "stop" on "${task.command}" in the session-activity pane` })
    .catch(() => undefined)
  await killPids($, [...(task.pgid ? [`-${task.pgid}`] : []), ...task.pids.map(String)])
  const now = await $.clock.now()
  await patchShell($, id, s => ({ ...s, status: 'killed', endedAt: s.endedAt ?? now, ports: [], cpu: 0 }))
  $.ui.toast(`Stopped ${task.command.split('\n')[0]}`)
}

async function stopAgent($: $, id: string) {
  const agent = (await read($, agentsA)).find(a => a.id === id)
  const ran = await $.tool
    .call({ tool: 'TaskStop', task_id: id, consent: `The user pressed "stop" on agent "${agent?.description ?? id}" in the session-activity pane` })
    .catch((err: unknown) => ({ deny: String(err) }))
  if (ran.deny !== undefined || ran.isError) $.ui.toast(`Could not stop the agent: ${ran.deny ?? ran.text ?? 'TaskStop failed'}`)
  else $.ui.toast(`Stopped ${agent?.type ?? 'agent'}: ${agent?.description ?? id}`)
  await tick($)
}

async function killOrphan($: $, pid: number) {
  await killPids($, [String(pid)])
  await update($, orphansA, list => list.filter(o => o.pid !== pid))
  $.ui.toast(`Killed pid ${pid}`)
}

async function stopAll($: $) {
  const [shells, orphans] = await Promise.all([read($, shellsA), read($, orphansA)])
  for (const s of shells.filter(s => s.status === 'running')) await stopShell($, s.id)
  for (const o of orphans) await killOrphan($, o.pid)
}

async function confirmThen($: $, key: string, act: () => Promise<void>) {
  if ((await read($, confirmA)) === key) {
    await update($, confirmA, () => '')
    await act()
    return
  }
  await update($, confirmA, () => key)
  $.clock.after(CONFIRM_MS, () => {
    void update($, confirmA, k => (k === key ? '' : k))
  })
}

export const register: Register = (on, options) => {
  onExit = options.onExit === 'leave' ? 'leave' : 'stop'
  notifyAfterMs = Number(options.notifyAfterSeconds ?? 30) * 1000
  quietMs = Number(options.quietMinutes ?? 5) * 60_000
  clearAfterMs = Number(options.clearFinishedAfterMinutes ?? 2) * 60_000

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    $.clock.every(TICK_MS, () => void tick($))
    await $.command.register({
      name: 'activity',
      description: 'Show or hide the session activity pane; `/activity stop-all` stops every background server and orphan',
    })
    try {
      const root = await sessionRoot($)
      await update($, rootPidA, () => root)
    } catch {}
    try {
      await $.tool.register({ name: TODO_TOOL, description: TODO_DESCRIPTION, inputSchema: TODO_SCHEMA, isDeferred: false })
    } catch {}
    return started
  })

  on('command.run', { command: 'activity' }, async ($, e) => {
    if (e.args.trim() === 'stop-all') {
      await stopAll($)
      return { text: 'Stopped every background server and orphan.' }
    }
    const panes = await $.ui.panes()
    if (panes.some(p => p.id === PANE)) {
      isDismissed = true
      await $.ui.close({ id: PANE })
      return { text: 'Session activity pane closed.' }
    }
    isDismissed = false
    await $.ui.open({ id: PANE, title: 'Session activity' })
    await tick($)
    return { text: 'Session activity pane opened.' }
  })

  on('session.end', async ($, e, next) => {
    if (onExit === 'stop' && e.reason !== 'clear') {
      const [shells, orphans] = await Promise.all([read($, shellsA), read($, orphansA)])
      const targets = [
        ...shells.filter(s => s.status === 'running').flatMap(s => [...(s.pgid ? [`-${s.pgid}`] : []), ...s.pids.map(String)]),
        ...orphans.map(o => String(o.pid)),
      ]
      if (targets.length > 0) await $.process.run(['kill', '-TERM', '--', ...targets]).catch(() => undefined)
    }
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') isDismissed = true
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PreToolUse', { tool: 'Bash' }, async ($, e, next) => {
    const decided = await next(e)
    const command = decided.updatedInput?.command
    if (e.tool_use_id && typeof command === 'string') ranCommands.set(e.tool_use_id, command)
    return decided
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: ['Bash', 'Monitor'] }, async ($, e, next) => {
    let ranCommand: string | undefined
    const ran = await next(e).finally(() => {
      if (!e.tool_use_id) return
      ranCommand = ranCommands.get(e.tool_use_id)
      ranCommands.delete(e.tool_use_id)
    })
    const result = ran.result as { backgroundTaskId?: string; taskId?: string } | undefined
    const id = e.tool === 'Bash' ? result?.backgroundTaskId : result?.taskId
    if (!id || ran.deny !== undefined || ran.isError) return ran
    const outputPath = parseOutputPath(ran.text) ?? (tasksDir ? `${tasksDir}/${id}.output` : undefined)
    if (outputPath) tasksDir = outputPath.slice(0, outputPath.lastIndexOf('/'))
    const now = await $.clock.now()
    const task: ShellTask = {
      id,
      kind: e.tool === 'Bash' ? 'shell' : 'monitor',
      command: e.tool === 'Bash' ? e.command : (e.command ?? e.ws?.url ?? e.description),
      shellCommand: ranCommand,
      description: e.description,
      agentId: e.agentId,
      startedAt: now,
      status: 'running',
      outputPath,
      pids: [],
      ports: [],
      cpu: 0,
      rssKb: 0,
    }
    await update($, shellsA, list => [...list.filter(s => s.id !== id), task])
    void maybeOpen($)
    $.clock.after(300, () => void tick($))
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: TODO_TOOL_CALL }, async ($, e) => {
    if (e.agentId) return { result: 'Not saved: only the main conversation writes the todo list the user watches. Keep your own steps in your report.', isError: true }
    const error = todoInputError(e)
    if (error) return { result: `Not saved: ${error}`, isError: true }
    const now = await $.clock.now()
    await update($, todosA, prev => applyTodos(prev, e as unknown as TodoInput, now))
    void maybeOpen($)
    await refreshBranch($, now)
    await refreshStatus($)
    const todos = await read($, todosA)
    const done = todos.items.filter(i => i.status === 'completed' || i.status === 'skipped').length
    return { result: `Saved ${todos.items.length} items, ${done} done. The user sees them in the session-activity pane.` }
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError || e.agentId) return ran
    const now = await $.clock.now()
    const items = e.todos.map(t => ({ content: t.content, status: t.status }))
    await update($, todosA, prev => applyTodos(prev, { items }, now))
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.tool_use_id) agentCalls.set(e.tool_use_id, { effort: e.effort, isolation: e.isolation })
    return next(e)
  }).catch(($, e, next) => next(e))

  // Everything a spawn is filed under is read before `next`, which returns only once the agent has started.
  on('agent.spawn', async ($, e, next) => {
    const call = agentCalls.get(e.tool_use_id)
    agentCalls.delete(e.tool_use_id)
    const resumed = e.resume ? (await read($, spawnsA))[e.resume.agentId] : undefined
    const def = resumed ? { isReadOnly: resumed.isReadOnly ?? false } : await agentDef($, e.subagentType)
    const [todos, before] = await Promise.all([read($, todosA), def.isReadOnly ? gitStatus($) : undefined])
    const spawned = await next(e)
    const id = spawned.agentId
    if (spawned.deny !== undefined || !id) return spawned
    const treeBefore = before === undefined ? undefined : porcelainLines(before)
    if (resumed) {
      await update($, spawnsA, all => ({ ...all, [id]: { ...resumed, treeBefore } }))
      return spawned
    }
    const [agents, metrics] = await Promise.all([read($, agentsA), read($, metricsA)])
    const prior = agents.filter(a => a.id !== id && a.description === e.description && a.type === e.subagentType && !isAgentActive(a.status)).at(-1)
    const ran = prior ? metrics[prior.id] : undefined
    const isEscalation =
      (e.model !== undefined && ran?.model !== undefined && !modelMatches(e.model, ran.model)) ||
      (call?.effort !== undefined && ran?.effort !== undefined && call.effort !== ran.effort)
    const info: SpawnInfo = {
      todo: e.parentAgentId ? undefined : currentTodo(todos),
      wantModel: e.fork ? undefined : (e.model ?? def.model),
      wantEffort: e.fork ? undefined : (call?.effort ?? def.effort),
      isReadOnly: def.isReadOnly,
      isolation: call?.isolation,
      escalatedFrom: isEscalation ? prior?.id : undefined,
      treeBefore,
    }
    await update($, spawnsA, all => ({ ...all, [id]: info }))
    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    const info = id ? (await read($, spawnsA))[id] : undefined
    if (id && info && e.usage) {
      const model = formatModel(e.usage.model)
      const tokens = usageTokens(e.usage)
      await update($, spendA, all => ({ ...all, [model]: (all[model] ?? 0) + tokens }))
    }
    if (id && info) {
      const verdict = parseVerdict(e.answer)
      // shortcut: porcelain lines miss a second edit to an already-modified file and blame this agent for a concurrent writer's edits; hash `git diff HEAD` if that bites.
      const after = info.treeBefore ? await gitStatus($) : undefined
      await update($, spawnsA, all => ({
        ...all,
        [id]: {
          ...all[id],
          verdict: verdict ?? all[id]?.verdict,
          // A resume retakes the snapshot, so its count must not erase an earlier run's.
          changedFiles: after === undefined ? all[id]?.changedFiles : Math.max(all[id]?.changedFiles ?? 0, newChanges(info.treeBefore ?? [], after)),
        },
      }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /^(?!(Agent|Task)$)/ }, async ($, e, next) => {
    if (e.agentId) {
      const line = summarizeToolUse(e.tool, e as unknown as Record<string, unknown>)
      await metricsOf($, e.agentId, m => ({ ...m, toolUses: m.toolUses + 1, activity: [...m.activity, line].slice(-3) }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId) {
      const now = await $.clock.now()
      await metricsOf($, e.agentId, m => ({ ...m, startedAt: m.startedAt ?? now, prompt: m.prompt ?? (e.text || undefined) }))
      void maybeOpen($)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) return yield* next(e)
    const agentId = e.agentId
    const effort = formatEffort(e.effort)
    await metricsOf($, agentId, m => ({ ...m, model: e.model, effort }))
    for await (const chunk of next(e)) {
      if (chunk.kind === 'stop' && chunk.usage) {
        const tokens = usageTokens(chunk.usage)
        await metricsOf($, agentId, m => ({ ...m, tokens }))
      }
      yield chunk
    }
  })

  on('classic.Stop', async ($, e, next) => {
    if (e.background_tasks) {
      const live = new Set(e.background_tasks.map(t => t.id))
      const now = await $.clock.now()
      await update($, shellsA, list => reconcileRunning(list, live, now))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'task-notification') return next(e)
    const notices = parseTaskNotifications(e.text)
    const now = await $.clock.now()
    const shells = await read($, shellsA)
    for (const notice of notices) {
      const task = shells.find(s => s.id === notice.taskId)
      if (!task) continue
      const status =
        notice.status === 'killed' || notice.status === 'stopped'
          ? 'killed'
          : notice.status === 'failed' || (notice.exitCode !== undefined && notice.exitCode !== 0)
            ? 'failed'
            : 'completed'
      await patchShell($, task.id, s => ({ ...endedTask(s, status, notice.exitCode, now), outputPath: s.outputPath ?? notice.outputPath }))
      await announceEnd($, task.id)
    }
    void refreshStatus($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const [agents, metrics, shells, orphans, confirm, expanded, todos, spawns, branch, spendTotals, now] = await Promise.all([
      read($, agentsA),
      read($, metricsA),
      read($, shellsA),
      read($, orphansA),
      read($, confirmA),
      read($, expandedA),
      read($, todosA),
      read($, spawnsA),
      read($, branchA),
      read($, spendA),
      $.clock.now(),
    ])

    const toggle = (key: string) => () =>
      void update($, expandedA, list => (list.includes(key) ? list.filter(k => k !== key) : [...list, key]))
    const isNarrow = (e.props.bodyColumns ?? 80) < NARROW_COLUMNS
    const confirmButton = (key: string, label: string, act: () => Promise<void>, glyph?: string) => (
      <Button
        key={key}
        label={confirm === key ? `${isNarrow && glyph ? label : `confirm ${label}`}?` : isNarrow && glyph ? glyph : label}
        variant={confirm === key ? 'primary' : undefined}
        dimColor={confirm !== key}
        onPress={() => void confirmThen($, key, act)}
      />
    )
    const titleLine = (key: string, glyph: string, color: string, title: string, right: JSX.Element[], suffix?: string) => (
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Box flexShrink={1} minWidth={0}>
          <Button key={`${key}:toggle`} plain onPress={toggle(key)}>
            <Text wrap="truncate-end">
              <Text color={color}>{glyph}</Text> {title}
              {suffix ? <Text dimColor> · {suffix}</Text> : ''}
            </Text>
          </Button>
        </Box>
        <Box flexDirection="row" gap={1} flexShrink={0}>
          {right}
        </Box>
      </Box>
    )
    const subLine = (indent: string, text: string, color?: string) => (
      <Text dimColor color={color} wrap="truncate-end">
        {indent}  {text}
      </Text>
    )

    const agentIcon = (a: AgentRow) =>
      a.status === 'running' || a.status === 'pending'
        ? { glyph: a.status === 'pending' ? '○' : '●', color: 'suggestion' }
        : a.status === 'completed'
          ? { glyph: '✓', color: 'success' }
          : a.status === 'failed'
            ? { glyph: '✗', color: 'error' }
            : a.status === 'killed'
              ? { glyph: '■', color: 'inactive' }
              : { glyph: '◌', color: 'inactive' }

    const depthOf = (a: AgentRow): number => {
      const parent = a.parentId ? agents.find(p => p.id === a.parentId) : undefined
      return parent ? 1 + depthOf(parent) : 0
    }
    const ordered: AgentRow[] = []
    const visit = (parentId: string | undefined) => {
      for (const a of agents.filter(x => x.parentId === parentId || (parentId === undefined && x.parentId && !agents.some(p => p.id === x.parentId)))) {
        if (ordered.includes(a)) continue
        ordered.push(a)
        visit(a.id)
      }
    }
    visit(undefined)

    const todoTexts = new Set(todos.items.map(i => i.content))
    const todoOf = (a: AgentRow): string | undefined => {
      const parent = a.parentId ? agents.find(p => p.id === a.parentId) : undefined
      if (parent) return todoOf(parent)
      const todo = spawns[a.id]?.todo
      return todo && todoTexts.has(todo) ? todo : undefined
    }
    const agentsUnder = (todo: string | undefined) => ordered.filter(a => todoOf(a) === todo)
    const otherAgents = agentsUnder(undefined)
    const activeAgents = otherAgents.filter(a => isAgentActive(a.status)).length
    const runningShells = shells.filter(s => s.status === 'running')
    const finishedShells = shells.filter(s => s.status !== 'running')
    const hasFinished = finishedShells.length > 0 || agents.some(a => !isAgentActive(a.status))

    const agentRow = (a: AgentRow) => {
      const m = metrics[a.id] ?? { toolUses: 0, tokens: 0, activity: [] }
      const sp: SpawnInfo = spawns[a.id] ?? {}
      const isWrongModel = sp.wantModel !== undefined && m.model !== undefined && !modelMatches(sp.wantModel, m.model)
      const isWrongEffort = sp.wantEffort !== undefined && m.effort !== undefined && /^[a-z]+$/.test(m.effort) && sp.wantEffort !== m.effort
      const isRouted = (sp.wantModel !== undefined || sp.wantEffort !== undefined) && m.model !== undefined && !isWrongModel && !isWrongEffort
      const prior = sp.escalatedFrom ? metrics[sp.escalatedFrom] : undefined
      const priorVerdict = sp.escalatedFrom ? spawns[sp.escalatedFrom]?.verdict : undefined
      const role = /^conductor[:-]/.test(a.type) ? `${a.type.slice('conductor-'.length)}  ` : ''
      const isActive = isAgentActive(a.status)
      const elapsed = formatDuration((a.endedAt ?? now) - (m.startedAt ?? a.firstSeenAt))
      const key = `agent:${a.id}`
      const isOpen = expanded.includes(key)
      const indent = '  '.repeat(depthOf(a))
      const meta = [
        m.model ? formatModel(m.model) : undefined,
        m.effort === undefined ? undefined : `${m.effort}${isRouted ? ' ✓' : ''}`,
        sp.isolation,
        isActive ? undefined : a.status,
        elapsed,
        `${m.toolUses} tool${m.toolUses === 1 ? '' : 's'}`,
        m.tokens > 0 ? `${formatTokens(m.tokens)} tok` : undefined,
      ]
        .filter(Boolean)
        .join(' · ')
      const activity = m.activity[m.activity.length - 1]
      const view = <Button key={`${key}:view`} label="view" dimColor onPress={() => void $.ui.view({ agentId: a.id })} />
      const stop = isActive ? confirmButton(`${key}:stop`, 'stop', () => stopAgent($, a.id), '■') : undefined
      const verdict = sp.verdict ? [<Text bold color={VERDICT_COLOR[sp.verdict]}>{sp.verdict}</Text>] : []
      const right = isNarrow
        ? [...(verdict.length > 0 ? verdict : [<Text dimColor>{isActive ? elapsed : a.status}</Text>]), ...(stop ? [stop] : [])]
        : [...verdict, view, ...(stop ? [stop] : [])]
      const warnings = [
        isWrongModel || isWrongEffort
          ? `⚠ ran ${[m.model && formatModel(m.model), m.effort].filter(Boolean).join(' ')}; its definition asks for ${[sp.wantModel, sp.wantEffort].filter(Boolean).join(' ')}`
          : undefined,
        sp.changedFiles ? `⚠ ${sp.changedFiles} file${sp.changedFiles === 1 ? '' : 's'} changed in the tree while this read-only agent ran` : undefined,
      ].filter((w): w is string => w !== undefined)
      const icon = warnings.length > 0 && a.status === 'completed' ? { glyph: '⚠', color: 'warning' } : agentIcon(a)
      return (
        <Box key={key} flexDirection="column">
          {titleLine(key, `${indent}${icon.glyph}`, icon.color, `${role}${a.name ? `${a.name}: ` : ''}${a.description}`, right)}
          {(!isNarrow || isOpen) && subLine(indent, meta)}
          {(!isNarrow || isOpen) && prior && subLine(indent, `↑ escalated from ${prior.model ? formatModel(prior.model) : 'an earlier run'}${priorVerdict ? ` (${priorVerdict})` : ''}`)}
          {warnings.map(w => subLine(indent, w, 'warning'))}
          {!isOpen && !isNarrow && isActive && activity && subLine(indent, `⎿ ${activity}`)}
          {isOpen && (
            <Box flexDirection="column">
              {m.prompt && subLine(indent, `Prompt: ${m.prompt.split('\n')[0]}`)}
              {m.activity.map(line => subLine(indent, `⎿ ${line}`))}
              {subLine(indent, `${a.type} · id ${a.id}${m.model ? ` · ${m.model}` : ''}`)}
              {isNarrow && <Box paddingLeft={indent.length + 2}>{view}</Box>}
            </Box>
          )}
        </Box>
      )
    }

    const shellRow = (s: ShellTask) => {
      const key = `shell:${s.id}`
      const isOpen = expanded.includes(key)
      const isRunning = s.status === 'running'
      const isQuiet = isRunning && s.ports.length === 0 && s.lastOutputAt !== undefined && now - s.lastOutputAt >= quietMs
      const icon = isRunning
        ? { glyph: '●', color: isQuiet ? 'warning' : 'suggestion' }
        : s.status === 'completed'
          ? { glyph: '✓', color: 'success' }
          : s.status === 'failed'
            ? { glyph: '✗', color: 'error' }
            : { glyph: '■', color: 'inactive' }
      const title = s.description ?? summarizeCommand(s.command)
      const usage = s.shellPid ? `${Math.round(s.cpu)}% CPU · ${formatMemory(s.rssKb)}` : now - s.startedAt > 10_000 ? 'process not found' : undefined
      const outcome = s.status === 'failed' ? (s.exitCode !== undefined ? `exit ${s.exitCode}` : 'failed') : s.status === 'completed' ? 'done' : 'stopped'
      const ago = `${formatDuration(now - (s.endedAt ?? now))} ago`
      const meta = isRunning
        ? [formatDuration(now - s.startedAt), usage, isQuiet ? `quiet ${formatDuration(now - (s.lastOutputAt ?? now))}` : undefined]
        : [outcome, `ran ${formatDuration((s.endedAt ?? now) - s.startedAt)}`, ago]
      const ports = s.ports.map(port => <Link href={`http://localhost:${port}`} label={`:${port}`} />)
      const stop = isRunning ? [confirmButton(`${key}:stop`, 'stop', () => stopShell($, s.id), '■')] : []
      const right = isNarrow
        ? [
            ...ports.slice(0, 1),
            <Text dimColor color={s.status === 'failed' ? 'error' : undefined}>
              {isRunning ? (s.shellPid ? `${Math.round(s.cpu)}%` : formatDuration(now - s.startedAt)) : s.status === 'failed' ? outcome : ago}
            </Text>,
            ...stop,
          ]
        : [...ports, ...(s.status === 'failed' ? [<Text color="error">{outcome}</Text>] : []), ...stop]
      return (
        <Box key={key} flexDirection="column">
          {titleLine(key, icon.glyph, icon.color, title, right, s.kind === 'monitor' && !isNarrow ? 'monitor' : undefined)}
          {(!isNarrow || isOpen) && subLine('', meta.filter(Boolean).join(' · '), isQuiet ? 'warning' : undefined)}
          {!isNarrow && s.lastLine && (isRunning || isOpen) && subLine('', `▸ ${shortenPaths(s.lastLine)}`)}
          {isOpen && (
            <Box flexDirection="column" paddingLeft={2}>
              {isNarrow && s.lastLine && <Text dimColor wrap="truncate-end">▸ {shortenPaths(s.lastLine)}</Text>}
              <Text dimColor>{shortenPaths(s.command)}</Text>
              <Text dimColor wrap="truncate-end">
                task {s.id}
                {s.shellPid ? ` · pid ${s.shellPid}` : ''}
                {s.peakRssKb ? ` · peak ${formatMemory(s.peakRssKb)}` : ''}
                {s.agentId ? ` · from agent ${s.agentId}` : ''}
              </Text>
              {s.outputPath && <Text dimColor wrap="truncate-start">{s.outputPath}</Text>}
            </Box>
          )}
        </Box>
      )
    }

    const stoppedMonitors = finishedShells.filter(s => s.kind === 'monitor' && s.status === 'killed')
    const groupsMonitors = stoppedMonitors.length >= 2
    const listedFinished = (groupsMonitors ? finishedShells.filter(s => !stoppedMonitors.includes(s)) : finishedShells).slice(-8)
    const isGroupOpen = expanded.includes(MONITOR_GROUP)
    const monitorGroup = groupsMonitors && (
      <Box key={MONITOR_GROUP} flexDirection="column">
        {titleLine(MONITOR_GROUP, '■', 'inactive', `${stoppedMonitors.length} stopped monitors`, [
          <Button key={`${MONITOR_GROUP}:show`} label={isGroupOpen ? 'hide' : 'show'} dimColor onPress={toggle(MONITOR_GROUP)} />,
        ])}
        {isGroupOpen && <Box flexDirection="column" paddingLeft={2}>{stoppedMonitors.map(shellRow)}</Box>}
      </Box>
    )

    const isEmpty = agents.length === 0 && shells.length === 0 && orphans.length === 0 && todos.items.length === 0
    const doneCount = todos.items.filter(i => i.status === 'completed' || i.status === 'skipped').length
    const isBad = (a: AgentRow) =>
      a.status === 'failed' || (spawns[a.id]?.changedFiles ?? 0) > 0 || ['ISSUES', 'BLOCKED', 'FAIL'].includes(spawns[a.id]?.verdict ?? '')

    const repo = repoOf(todos.link) ?? branch.repo
    // One column wide enough for the longest ticket keeps every item's text aligned.
    const ticketWidth = Math.max(0, ...todos.items.map(i => ticketOf(i, repo).ticket?.label.length ?? 0))
    const { now: nowItems, next: nextItems, done: doneItems } = groupTodos(todos.items)
    const todoRow = (item: TodoItem) => {
      const key = `todo:${item.content}`
      const under = agentsUnder(item.content)
      const isOpen = item.status === 'in_progress' ? !expanded.includes(key) : expanded.includes(key)
      const icon = TODO_ICON[item.status]
      const count = `${under.length} agent${under.length === 1 ? '' : 's'}`
      const right =
        item.status === 'skipped'
          ? `skip${item.note && !isNarrow ? `: ${item.note}` : ''}`
          : item.status === 'in_progress'
            ? [item.startedAt === undefined ? undefined : formatDuration(now - item.startedAt), under.length > 0 ? count : undefined].filter(Boolean).join(' · ')
            : under.length > 0
              ? `${count} ${under.some(isBad) ? '✗' : '✓'}`
              : (item.note ?? '')
      const { ticket, text } = ticketOf(item, repo)
      return (
        <Box key={key} flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Box flexDirection="row" flexShrink={1} minWidth={0}>
              <Text color={icon.color}>{icon.glyph} </Text>
              {ticketWidth > 0 && (
                <Box width={ticketWidth + 1} flexShrink={0}>
                  {ticket && (ticket.href ? <Link href={ticket.href} label={ticket.label} /> : <Text dimColor>{ticket.label}</Text>)}
                </Box>
              )}
              <Box flexShrink={1} minWidth={0}>
                <Button key={`${key}:toggle`} plain onPress={toggle(key)}>
                  <Text wrap="truncate-end">{text}</Text>
                </Button>
              </Box>
            </Box>
            {right && (
              <Box flexShrink={0}>
                <Text dimColor>{right}</Text>
              </Box>
            )}
          </Box>
          {isOpen && under.length > 0 && (
            <Box flexDirection="column" paddingLeft={2}>
              {under.map(agentRow)}
            </Box>
          )}
        </Box>
      )
    }

    const barWidth = Math.max(10, Math.min(60, (e.props.bodyColumns ?? 80) - 12))
    const filled = todos.items.length === 0 ? 0 : Math.round((doneCount / todos.items.length) * barWidth)
    const prLabel = todos.link ? (/(\d+)\/?$/.exec(todos.link)?.[1] ? `#${/(\d+)\/?$/.exec(todos.link)?.[1]}` : 'issue') : undefined
    const branchWords = branch.branch
      ? [
          branch.branch,
          branch.behind === undefined ? undefined : `${branch.behind} behind ${branch.trunk?.replace(/^origin\//, '') ?? 'trunk'}`,
          `${branch.changed} changed`,
          branch.pr ? `PR #${branch.pr}` : 'no PR',
        ].filter(Boolean)
      : []
    const isNextOpen = !isNarrow || expanded.includes('todos')
    const isDoneOpen = expanded.includes('todos:done')
    const todoSection = todos.items.length > 0 && (
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Box flexShrink={1} minWidth={0}>
            <Text wrap="truncate-end">
              <Text bold>{(todos.title ?? 'Todos').toUpperCase()}</Text>
              <Text dimColor>
                {' '}
                · {doneCount} of {todos.items.length} done
              </Text>
            </Text>
          </Box>
          {todos.link && prLabel && <Link href={todos.link} label={prLabel} />}
        </Box>
        {!isNarrow && branchWords.length > 0 && (
          <Text dimColor wrap="truncate-end" color={(branch.behind ?? 0) > 0 ? 'warning' : undefined}>
            {branchWords.join(' · ')}
          </Text>
        )}
        <Text>
          <Text color="suggestion">{'━'.repeat(filled)}</Text>
          <Text dimColor>{'━'.repeat(barWidth - filled)}</Text>
        </Text>
        {nowItems.length > 0 && <Text bold>NOW</Text>}
        {nowItems.map(todoRow)}
        {nextItems.length > 0 && <Text bold>NEXT</Text>}
        {(isNextOpen ? nextItems : nextItems.slice(0, 1)).map(todoRow)}
        {isNarrow && nextItems.length > 1 && (
          <Button key="todos:toggle" label={isNextOpen ? 'fewer' : `+${nextItems.length - 1} more`} dimColor onPress={toggle('todos')} />
        )}
        {doneItems.length > 0 && (
          <Box flexDirection="row" gap={1}>
            <Text bold dimColor>{`DONE · ${doneItems.length}`}</Text>
            <Button key="todos:done" label={isDoneOpen ? 'hide' : 'show'} dimColor onPress={toggle('todos:done')} />
          </Box>
        )}
        {isDoneOpen && doneItems.map(todoRow)}
      </Box>
    )
    const spend = Object.entries(spendTotals).sort((a, b) => b[1] - a[1])

    return (
      <Box flexDirection="column" paddingX={1}>
        {isEmpty && <Text dimColor>Nothing running. Todos, subagents and background commands from this session show up here.</Text>}

        {todoSection}

        {otherAgents.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text>
              <Text bold>{todos.items.length > 0 ? 'OTHER AGENTS' : 'AGENTS'}</Text>
              <Text dimColor> · {activeAgents} running</Text>
            </Text>
            {otherAgents.map(agentRow)}
          </Box>
        )}

        {shells.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text wrap="truncate-end">
              <Text bold>{isNarrow ? 'SCRIPTS' : 'SERVERS & SCRIPTS'}</Text>
              <Text dimColor>
                {' '}
                · {runningShells.length} running
                {runningShells.some(s => s.shellPid) ? ` · ${Math.round(runningShells.reduce((sum, s) => sum + s.cpu, 0))}% CPU` : ''}
                {runningShells.some(s => s.shellPid) && !isNarrow ? ` · ${formatMemory(runningShells.reduce((sum, s) => sum + s.rssKb, 0))}` : ''}
              </Text>
            </Text>
            {runningShells.map(shellRow)}
            {monitorGroup}
            {listedFinished.map(shellRow)}
          </Box>
        )}

        {orphans.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text>
              <Text bold color="warning">⚠ ORPHANS</Text>
              <Text dimColor> · outlived their task</Text>
            </Text>
            {orphans.map(o => (
              <Box key={`orphan:${o.pid}`} flexDirection="column">
                {titleLine(`orphan:${o.pid}`, '●', 'warning', shortenPaths(o.args), [
                  ...o.ports.slice(0, isNarrow ? 1 : undefined).map(port => <Link href={`http://localhost:${port}`} label={`:${port}`} />),
                  confirmButton(`orphan:${o.pid}:kill`, 'kill', () => killOrphan($, o.pid)),
                ])}
                {(!isNarrow || expanded.includes(`orphan:${o.pid}`)) && subLine('', `pid ${o.pid} · left by ${summarizeCommand(o.command)}`)}
              </Box>
            ))}
          </Box>
        )}

        {spend.length > 0 && (
          <Box marginBottom={1}>
            <Text wrap="truncate-end">
              <Text bold>SPEND</Text>
              <Text dimColor> · {spend.map(([model, tokens]) => `${model} ${formatTokens(tokens)}`).join(' · ')}</Text>
            </Text>
          </Box>
        )}

        {(runningShells.length > 0 || orphans.length > 0 || hasFinished) && (
          <Box flexDirection="row" gap={1}>
            {(runningShells.length > 0 || orphans.length > 0) && confirmButton('stop-all', isNarrow ? 'stop all' : 'stop all servers', () => stopAll($))}
            {hasFinished && (
              <Button
                key="clear-finished"
                label={isNarrow ? 'clear' : 'clear finished'}
                dimColor
                onPress={() => {
                  void update($, shellsA, list => list.filter(s => s.status === 'running'))
                  void update($, agentsA, list => list.filter(a => isAgentActive(a.status)))
                }}
              />
            )}
          </Box>
        )}
      </Box>
    )
  })
}
