import { describe, expect, test } from 'claude-code/testing'

import type { ShellTask } from '../types'

import {
  shortenPaths,
  summarizeCommand,
  cpuSince,
  parseProcStat,
  exitCodeOf,
  readTail,
  expireFinished,
  mergeScan,
  reconcileRunning,
  findSessionRoot,
  findTaskShell,
  formatDuration,
  formatModel,
  lastLine,
  mergeAgents,
  orphansOf,
  parseLsof,
  parseOutputPath,
  parsePs,
  parseSs,
  parseTaskNotifications,
  summarizeToolUse,
  treeOf,
  applyTodos,
  currentTodo,
  todoInputError,
  parseVerdict,
  settleFinished,
  parseAgentDef,
  modelMatches,
  newChanges,
  parseBranch,
  agentName,
  groupTodos,
  pluginAgentPaths,
  pluginInstallPath,
  contextRepo,
  repoOf,
  ticketOf,
  todoTitle,
} from '../hooks/lib'

const PS = [
  '    1     0     1  0.0  1200 /sbin/init',
  '  100     1   100  1.0 90000 claude --dangerously-skip-permissions',
  `  200   100   200  0.0  3000 /bin/bash -c source /x/snapshot.sh && eval 'pnpm dev' < /dev/null && pwd -P`,
  '  201   200   200  2.5 40000 node /repo/node_modules/.bin/next dev',
  '  202   201   200 12.0 300000 next-server (v16.0.0)',
  `  300   100   300  0.0  3000 /bin/bash -c eval 'echo '"'"'hi'"'"''`,
].join('\n')

describe('process table', () => {
  const rows = parsePs(PS)

  test('parses every row with its args intact', () => {
    expect(rows.length).toBe(6)
    expect(rows[4]).toEqual({ pid: 202, ppid: 201, pgid: 200, cpu: 12, rssKb: 300000, args: 'next-server (v16.0.0)' })
  })

  test('finds the claude process above a helper', () => {
    expect(findSessionRoot(rows, 100)).toBe(100)
  })

  test('stops at the versioned binary a daemon session runs, not the pty host above it', () => {
    const daemon = parsePs([
      '  700     1   700  0.0  9000 claude bg-pty-host --bg-pty-host /tmp/p.sock 200 50 -- /home/u/.local/share/claude/versions/2.1.308 --session-id s',
      '  710   700   710  1.0 90000 /home/u/.local/share/claude/versions/2.1.308 --session-id s --resume /x.jsonl',
      '   50   710    50  0.0   100 sh -c ps',
    ].join('\n'))
    expect(findSessionRoot(daemon, 50)).toBe(710)
  })

  test('matches a task to its wrapper shell, quoting included', () => {
    expect(findTaskShell(rows, 100, 'pnpm dev', new Set())?.pid).toBe(200)
    expect(findTaskShell(rows, 100, "echo 'hi'", new Set())?.pid).toBe(300)
    expect(findTaskShell(rows, 100, 'pnpm dev', new Set([200]))).toBeUndefined()
  })

  test('walks the whole process tree of a task', () => {
    expect(treeOf(rows, 200, 200).map(r => r.pid)).toEqual([200, 201, 202])
  })

  test('flags group members that outlived the shell as orphans', () => {
    const survivors = parsePs(PS).filter(r => r.pid !== 200 && r.pid !== 201)
    const orphans = orphansOf(
      survivors,
      { id: 'b1', kind: 'shell', command: 'pnpm dev', startedAt: 0, status: 'killed', shellPid: 200, pgid: 200, pids: [200, 201, 202], ports: [], cpu: 0, rssKb: 0 },
      new Map([[202, [3000]]]),
    )
    expect(orphans).toEqual([{ pid: 202, args: 'next-server (v16.0.0)', ports: [3000], taskId: 'b1', command: 'pnpm dev' }])
  })
})

describe('listening ports', () => {
  test('reads ss output', () => {
    const ss = 'LISTEN 0 511 *:3000 *:* users:(("next-server (v1",pid=202,fd=21))\nLISTEN 0 4096 [::1]:5432 [::]:* users:(("postgres",pid=9,fd=7))'
    expect(parseSs(ss)).toEqual(new Map([[202, [3000]], [9, [5432]]]))
  })

  test('reads lsof output', () => {
    expect(parseLsof('p202\nf21\nn*:3000\nn[::1]:3001\np9\nn127.0.0.1:5432')).toEqual(new Map([[202, [3000, 3001]], [9, [5432]]]))
  })
})

describe('notifications and output', () => {
  test('parses a task notification with its exit code', () => {
    const text = [
      '<task-notification>',
      '<task-id>bf7hyalsl</task-id>',
      '<output-file>/var/tmp/x/tasks/bf7hyalsl.output</output-file>',
      '<status>completed</status>',
      '<summary>Background command "Run tests" completed (exit code 1)</summary>',
      '</task-notification>',
    ].join('\n')
    expect(parseTaskNotifications(text)).toEqual([
      { taskId: 'bf7hyalsl', status: 'completed', exitCode: 1, outputPath: '/var/tmp/x/tasks/bf7hyalsl.output' },
    ])
  })

  test('reads the output path from a background Bash result', () => {
    expect(parseOutputPath('Command running in background with ID: b1. Output is being written to: /t/tasks/b1.output')).toBe('/t/tasks/b1.output')
  })

  test('takes the last visible line, colours and progress rewrites stripped', () => {
    expect(lastLine('one\n\x1b[32m✓ Compiled\x1b[0m\nwait 10%\rwait 90%\n\n')).toBe('wait 90%')
  })

  test('formats durations the way /tasks does', () => {
    expect(formatDuration(12_400)).toBe('12s')
    expect(formatDuration(134_000)).toBe('2m14s')
    expect(formatDuration(3_780_000)).toBe('1h03m')
  })

  test('summarizes a tool use as its most telling argument', () => {
    expect(summarizeToolUse('Read', { file_path: '/repo/apps/web/page.tsx' })).toBe('Read: page.tsx')
    expect(summarizeToolUse('Bash', { command: 'pnpm test\n--watch' })).toBe('Bash: pnpm test')
  })
})

describe('agents', () => {
  test('keeps a finished agent after the engine drops it, stamped with when it ended', () => {
    const first = mergeAgents([], [{ id: 'a1', type: 'Explore', description: 'Find callers', status: 'running' }], 1000)
    const second = mergeAgents(first, [], 5000)
    expect(second).toEqual([{ id: 'a1', type: 'Explore', description: 'Find callers', status: 'completed', firstSeenAt: 1000, endedAt: 5000 }])
  })
})

describe('finished runs', () => {
  test('an agent whose run has ended reads as completed, whatever the list still says', () => {
    const list = [
      { id: 'a', type: 't', description: 'd', status: 'running' },
      { id: 'b', type: 't', description: 'd', status: 'idle' },
      { id: 'c', type: 't', description: 'd', status: 'failed' },
      { id: 'd', type: 't', description: 'd', status: 'running' },
    ] as const
    const settled = settleFinished(list, { a: { isFinished: true }, b: { isFinished: true }, c: { isFinished: true }, d: { isFinished: false } })
    expect(settled.map(a => a.status)).toEqual(['completed', 'completed', 'failed', 'running'])
  })
})

describe('model label', () => {
  test('shortens model ids the way people say them', () => {
    expect(formatModel('claude-opus-5-5[1m]')).toBe('Opus 5.5')
    expect(formatModel('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(formatModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(formatModel('claude-fable-5-1')).toBe('Fable 5.1')
    expect(formatModel('us.anthropic.claude-opus-5-5')).toBe('Opus 5.5')
    expect(formatModel('some-gateway-model')).toBe('some-gateway-model')
  })
})

describe('finished scripts', () => {
  const task = (id: string, status: ShellTask['status'], endedAt?: number): ShellTask => ({
    id, kind: 'shell', command: id, startedAt: 0, status, endedAt, pids: [], ports: [], cpu: 0, rssKb: 0,
  })

  test('a scan never resurrects a cleared row or undoes an end that landed meanwhile', () => {
    const scanned = [{ ...task('a', 'running'), cpu: 9 }, { ...task('b', 'running'), cpu: 5 }, { ...task('c', 'running'), cpu: 1 }]
    const current = [task('b', 'completed', 100), task('c', 'running'), task('d', 'running')]
    expect(mergeScan(current, scanned).map(s => [s.id, s.status, s.cpu])).toEqual([
      ['b', 'completed', 0],
      ['c', 'running', 1],
      ['d', 'running', 0],
    ])
  })

  test('completed and stopped rows expire; failed and running ones stay', () => {
    const list = [task('done', 'completed', 0), task('stopped', 'killed', 0), task('broke', 'failed', 0), task('fresh', 'completed', 100_000), task('live', 'running')]
    expect(expireFinished(list, 120_000, 120_000).map(s => s.id)).toEqual(['broke', 'fresh', 'live'])
    expect(expireFinished(list, 120_000, 0).length).toBe(5)
  })

  test('a running row the engine no longer lists as in flight is marked ended', () => {
    const out = reconcileRunning([task('gone', 'running'), task('live', 'running')], new Set(['live']), 50)
    expect(out.map(s => [s.id, s.status, s.endedAt])).toEqual([
      ['gone', 'exited', 50],
      ['live', 'running', undefined],
    ])
  })
})

describe('exit marker', () => {
  test('reads the exit code the Bash tool writes last, and the line before it', () => {
    expect(readTail('compiling\nerror TS2345\n\n[exited with code 8]\n')).toEqual({ line: 'error TS2345', exitCode: 8 })
    expect(readTail('still going\n')).toEqual({ line: 'still going', exitCode: undefined })
    expect(exitCodeOf('[exited with code 0]')).toBe(0)
    expect(exitCodeOf('echo [exited with code 0]')).toBeUndefined()
  })
})

describe('linking a task to its processes', () => {
  const rows = parsePs([
    '  100     1   100  1.0 90000 claude --dangerously-skip-permissions',
    '  150     1   150  1.0 90000 claude --resume',
    `  200   100   200  0.0  3000 /bin/bash -c source /s.sh && eval 'pnpm dev' < /dev/null && pwd -P`,
    `  250   150   250  0.0  3000 /bin/bash -c source /s.sh && eval 'pnpm dev' < /dev/null && pwd -P`,
    `  300   100   300  0.0  3000 /bin/bash -c source /s.sh && eval 'cat > x <<EOF\npnpm dev\nEOF' < /dev/null`,
  ].join('\n'))

  test("claims this session's shell, never another session's running the same command", () => {
    expect(findTaskShell(rows, 100, 'pnpm dev', new Set())?.pid).toBe(200)
    expect(findTaskShell(rows, 100, 'pnpm dev', new Set([200]))).toBeUndefined()
    expect(findTaskShell(rows, 0, 'pnpm dev', new Set())).toBeUndefined()
  })

  test('ignores a shell that only mentions the command', () => {
    expect(findTaskShell(rows, 100, 'npm dev', new Set())).toBeUndefined()
  })
})

describe('current CPU', () => {
  test('reads utime and stime past a command name holding spaces and parens', () => {
    const stat = '42 (next-server (v16)) S 1 42 42 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 11 0 1 2 3'
    expect(parseProcStat(stat)).toEqual(new Map([[42, 300]]))
  })

  test('is the ticks spent over the interval, one busy core being 100%', () => {
    const before = new Map([[1, 1000], [2, 50]])
    const after = new Map([[1, 1200], [2, 50], [3, 999]])
    expect(cpuSince(before, after, [1, 2, 3], 2000)).toBe(100)
  })
})

describe('row labels for long commands', () => {
  const SCRATCH = '/var/tmp/claude-1000/-workspace--worktrees-implement-github-project-4/371a09cf-12d5-46cd-aae1-808ea9da5fc6/scratchpad'

  test('shortens scratchpad, worktree and home paths', () => {
    expect(shortenPaths(`cat ${SCRATCH}/487-e2e-2.log`)).toBe('cat scratch/487-e2e-2.log')
    expect(shortenPaths('cd /workspace/.worktrees/rd-441-releases/apps/web')).toBe('cd rd-441-releases/apps/web')
    expect(shortenPaths('ls /home/node/.claude/mods')).toBe('ls ~/.claude/mods')
  })

  test('names a wait loop by what it waits for', () => {
    const monitor = `until grep -q '^DONE' ${SCRATCH}/e2e-443c.log 2>/dev/null; do sleep 10; done; grep -n " passed" ${SCRATCH}/e2e-443c.log | head -40`
    expect(summarizeCommand(monitor)).toBe('wait for DONE in scratch/e2e-443c.log')
    expect(summarizeCommand(`until grep -q "EXIT" ${SCRATCH}/487-e2e-2.log; do sleep 5; done`)).toBe('wait for EXIT in scratch/487-e2e-2.log')
  })

  test('keeps the first line of anything else, with redirections dropped', () => {
    const e2e = `uptime; cd /workspace/.worktrees/rd-446-editor && pnpm test:e2e:chromium e2e/a.spec.ts > ${SCRATCH}/487-e2e-2.log 2>&1; echo EXIT $?`
    expect(summarizeCommand(e2e)).toBe('uptime; cd rd-446-editor && pnpm test:e2e:chromium e2e/a.spec.ts > scratch/487-e2e-2.log; echo EXIT $?')
    expect(summarizeCommand("cd /workspace/.worktrees/rd-443-runs/apps/web && python3 - <<'E'\nprint(1)\nE")).toBe("cd rd-443-runs/apps/web && python3 - <<'E'")
  })
})

describe('todos', () => {
  test('an item keeps when it started across replacements, matched by its text', () => {
    const first = applyTodos(undefined, { items: [{ content: 'Map', status: 'in_progress' }] }, 100)
    const second = applyTodos(first, { title: 'feature', items: [{ content: 'Map', status: 'in_progress' }, { content: 'Build', status: 'pending' }] }, 500)
    expect(second.title).toBe('feature')
    expect(second.items[0]?.startedAt).toBe(100)
    expect(second.items[1]?.startedAt).toBeUndefined()
  })

  test('a call without a title or link keeps the ones before; an empty string clears them', () => {
    const first = applyTodos(undefined, { title: 'feature', link: 'https://x/1', items: [] }, 1)
    expect(applyTodos(first, { items: [] }, 2)).toEqual({ title: 'feature', link: 'https://x/1', items: [] })
    expect(applyTodos(first, { title: '', items: [] }, 2)).toEqual({ link: 'https://x/1', items: [] })
  })

  test('an item that goes back to pending forgets when it started', () => {
    const first = applyTodos(undefined, { items: [{ content: 'Map', status: 'in_progress' }] }, 100)
    expect(applyTodos(first, { items: [{ content: 'Map', status: 'pending' }] }, 500).items[0]?.startedAt).toBeUndefined()
  })

  test('a spawn belongs to the in-progress item started last', () => {
    const list = applyTodos(
      applyTodos(undefined, { items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] }, 100),
      { items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'in_progress' }] },
      200,
    )
    expect(currentTodo(list)).toBe('B')
    expect(currentTodo(applyTodos(undefined, { items: [{ content: 'A', status: 'completed' }] }, 1))).toBeUndefined()
  })

  test('invalid input names what is wrong', () => {
    expect(todoInputError({ items: 'x' })).toMatch(/items/)
    expect(todoInputError({ items: [{ content: 'a', status: 'done' }] })).toMatch(/status/)
    expect(todoInputError({ items: [{ content: '', status: 'pending' }] })).toMatch(/content/)
    expect(todoInputError({ items: [{ content: 'a', status: 'skipped', note: 'n/a' }], title: 'feature' })).toBeUndefined()
    expect(todoInputError({ items: [{ content: 'a', status: 'pending', ticket: 12 }] })).toMatch(/ticket/)
  })

  test('an item keeps its ticket across replacements', () => {
    expect(applyTodos(undefined, { items: [{ content: 'Fix', status: 'pending', ticket: '#4' }] }, 1).items[0]).toEqual({ content: 'Fix', status: 'pending', ticket: '#4' })
  })

  test('items group into now, next and done, each in list order', () => {
    const items = [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
      { content: 'c', status: 'in_progress' },
      { content: 'd', status: 'skipped' },
      { content: 'e', status: 'pending' },
      { content: 'f', status: 'in_progress' },
    ] as const
    const { now, next, done } = groupTodos(items)
    expect(now.map(i => i.content)).toEqual(['c', 'f'])
    expect(next.map(i => i.content)).toEqual(['b', 'e'])
    expect(done.map(i => i.content)).toEqual(['a', 'd'])
  })
})

describe('tickets', () => {
  const REPO = 'wedgey/contexory'

  test('a repo is read from an issue link or a remote, https or ssh', () => {
    expect(repoOf('https://github.com/wedgey/contexory/issues/550')).toBe(REPO)
    expect(repoOf('git@github.com:wedgey/agent-kit.git')).toBe('wedgey/agent-kit')
    expect(repoOf('https://github.com/wedgey/agent-kit.git')).toBe('wedgey/agent-kit')
    expect(repoOf('https://gitlab.com/a/b')).toBeUndefined()
    expect(repoOf(undefined)).toBeUndefined()
    expect(repoOf('https://github.com/orgs/wedgey/projects/4')).toBeUndefined()
    expect(repoOf('https://github.com/users/wedgey/projects/1')).toBeUndefined()
    expect(repoOf('https://github.com/enterprises/acme')).toBeUndefined()
  })

  test("the repo in context is the list link's when that is an issue or PR, else origin's", () => {
    expect(contextRepo('https://github.com/wedgey/contexory/issues/550', 'wedgey/agent-kit')).toBe(REPO)
    expect(contextRepo('https://github.com/wedgey/contexory/pull/12', undefined)).toBe(REPO)
    expect(contextRepo('https://github.com/orgs/wedgey/projects/4', 'wedgey/agent-kit')).toBe('wedgey/agent-kit')
    expect(contextRepo('https://github.com/wedgey/contexory', 'wedgey/agent-kit')).toBe('wedgey/agent-kit')
    expect(contextRepo(undefined, undefined)).toBeUndefined()
  })

  test('a bare #N leads the text and links into the repo in context', () => {
    expect(ticketOf({ content: '#554 Rerun failed e2e once' }, REPO)).toEqual({
      ticket: { label: '#554', href: 'https://github.com/wedgey/contexory/issues/554' },
      text: 'Rerun failed e2e once',
    })
    expect(ticketOf({ content: '#554: Rerun' })).toEqual({ ticket: { label: '#554' }, text: 'Rerun' })
  })

  test('owner/repo#N names its own repo; an owner-less repo#N is no ticket', () => {
    expect(ticketOf({ content: 'wedgey/agent-kit#9 Conductor as a root plugin' }, REPO)).toEqual({
      ticket: { label: 'agent-kit#9', href: 'https://github.com/wedgey/agent-kit/issues/9' },
      text: 'Conductor as a root plugin',
    })
    expect(ticketOf({ content: 'acme/tool#3 Bump' }, REPO).ticket).toEqual({ label: 'tool#3', href: 'https://github.com/acme/tool/issues/3' })
    expect(ticketOf({ content: 'wedgey/contexory#3 Bump' }, REPO).ticket?.label).toBe('#3')
    expect(ticketOf({ content: 'agent-kit#9 x' }, REPO)).toEqual({ text: 'agent-kit#9 x' })
    expect(ticketOf({ content: 'step#2 of the plan' }, REPO)).toEqual({ text: 'step#2 of the plan' })
    expect(ticketOf({ content: 'C#9 interop' }, REPO)).toEqual({ text: 'C#9 interop' })
  })

  test('known limit: a leading "#1 priority" reads as ticket #1', () => {
    expect(ticketOf({ content: '#1 priority: fix login' }, REPO).ticket?.label).toBe('#1')
  })

  test('a GitHub issue or PR URL keeps its own address', () => {
    expect(ticketOf({ content: 'https://github.com/wedgey/contexory/pull/12 Ship it' }, REPO)).toEqual({
      ticket: { label: '#12', href: 'https://github.com/wedgey/contexory/pull/12' },
      text: 'Ship it',
    })
    expect(ticketOf({ content: 'https://github.com/wedgey/agent-kit/issues/9#issuecomment-1 Read' }, REPO).ticket).toEqual({
      label: 'agent-kit#9',
      href: 'https://github.com/wedgey/agent-kit/issues/9',
    })
  })

  test('the ticket field wins, and a matching lead in the text is not shown twice', () => {
    expect(ticketOf({ content: 'Fix the login redirect', ticket: '#123' }, REPO)).toEqual({
      ticket: { label: '#123', href: 'https://github.com/wedgey/contexory/issues/123' },
      text: 'Fix the login redirect',
    })
    expect(ticketOf({ content: '#123 Fix', ticket: '#123' }, REPO).text).toBe('Fix')
    expect(ticketOf({ content: '#7 Fix', ticket: '#123' }, REPO).text).toBe('#7 Fix')
    expect(ticketOf({ content: 'Fix', ticket: 'JIRA-4' })).toEqual({ ticket: { label: 'JIRA-4' }, text: 'Fix' })
  })

  test('a ticket URL off GitHub links under its last path segment, never the whole URL', () => {
    expect(ticketOf({ content: 'Fix', ticket: 'https://linear.app/acme/issue/ENG-12/' }, REPO)).toEqual({
      ticket: { label: 'ENG-12', href: 'https://linear.app/acme/issue/ENG-12/' },
      text: 'Fix',
    })
    expect(ticketOf({ content: 'Read', ticket: 'https://acme.atlassian.net/browse/OPS-7?focus=1' }).ticket?.label).toBe('OPS-7')
    expect(ticketOf({ content: 'Read', ticket: 'https://github.com/wedgey/contexory/discussions/40' }, REPO).ticket?.label).toBe('40')
  })

  test('no ticket: the text as written, and a # inside it is no ticket', () => {
    expect(ticketOf({ content: 'Session-activity pane: now/next split' }, REPO)).toEqual({ text: 'Session-activity pane: now/next split' })
    expect(ticketOf({ content: 'Fix bug #12 in auth' }, REPO)).toEqual({ text: 'Fix bug #12 in auth' })
    expect(ticketOf({ content: '#12abc tag' }, REPO)).toEqual({ text: '#12abc tag' })
  })

  test('a title is the ticket then the text', () => {
    expect(todoTitle({ content: 'Fix', ticket: '#9' }, REPO)).toBe('#9 Fix')
    expect(todoTitle({ content: 'Fix' }, REPO)).toBe('Fix')
  })
})

describe('delegates', () => {
  test('the STATUS line of a report gives the verdict', () => {
    expect(parseVerdict('STATUS     PASS+NOTES\nDID  x')).toBe('PASS+NOTES')
    expect(parseVerdict('notes\nSTATUS: ISSUES\n')).toBe('ISSUES')
    expect(parseVerdict('**STATUS** FAIL')).toBe('FAIL')
    expect(parseVerdict('all good')).toBeUndefined()
    expect(parseVerdict('Status: BLOCKED')).toBe('BLOCKED')
    expect(parseVerdict('> **STATUS** — PASS')).toBe('PASS')
    expect(parseVerdict('| STATUS | ISSUES |')).toBe('ISSUES')
    expect(parseVerdict('The STATUS line will say PASS')).toBeUndefined()
  })

  test('an agent definition gives its model, effort and whether it may write', () => {
    const def = parseAgentDef('---\nname: conductor-explorer\nmodel: haiku\neffort: low\ndisallowedTools: Agent, Edit, Write, NotebookEdit\n---\nbody model: opus')
    expect(def).toEqual({ model: 'haiku', effort: 'low', isReadOnly: true })
    expect(parseAgentDef('---\nmodel: sonnet\ndisallowedTools: Agent\n---\n').isReadOnly).toBe(false)
    expect(parseAgentDef('no frontmatter')).toEqual({ isReadOnly: false })
  })

  test('an alias matches any model id of its family', () => {
    expect(modelMatches('haiku', 'claude-haiku-5-5')).toBe(true)
    expect(modelMatches('opus', 'claude-sonnet-5-5')).toBe(false)
    expect(modelMatches('claude-opus-5-5', 'claude-opus-5-5[1m]')).toBe(true)
    expect(modelMatches('inherit', 'claude-sonnet-5-5')).toBe(true)
  })

  test('a definition in YAML list form, with CRLF line ends, or with a tools allowlist is read too', () => {
    expect(parseAgentDef('---\r\nmodel: opus\r\ndisallowedTools:\r\n  - Agent\r\n  - Edit\r\n---\r\n')).toEqual({ model: 'opus', isReadOnly: true })
    expect(parseAgentDef('---\ntools: Read, Grep, Bash\n---\n').isReadOnly).toBe(true)
    expect(parseAgentDef('---\ntools: Read, Edit\n---\n').isReadOnly).toBe(false)
    expect(parseAgentDef('---\ntools:\n- Read\n- Edit\n---\n').isReadOnly).toBe(false)
    expect(parseAgentDef('---\ndisallowedTools:\n- Edit\n---\n').isReadOnly).toBe(true)
    expect(parseAgentDef('---\ntools:\nmodel: opus\n---\n')).toEqual({ model: 'opus', isReadOnly: false })
  })

  test('an agent file is known by its frontmatter name', () => {
    expect(agentName('---\nname: implementer\nmodel: sonnet\n---\nname: other')).toBe('implementer')
    expect(agentName('---\r\nname: "reviewer"\r\n---\r\n')).toBe('reviewer')
    expect(agentName('no frontmatter')).toBeUndefined()
  })

  test('a plugin is found where it is installed, the project install first', () => {
    const installed = {
      version: 2,
      plugins: {
        'conductor@agent-kit': [
          { scope: 'user', installPath: '/c/cache/agent-kit/conductor/0.1.0' },
          { scope: 'project', projectPath: '/repo', installPath: '/c/cache/agent-kit/conductor/0.2.0' },
        ],
        'conductor-x@other': [{ scope: 'user', installPath: '/c/x' }],
      },
    }
    expect(pluginInstallPath(installed, 'conductor', '/repo/.worktrees/a')).toBe('/c/cache/agent-kit/conductor/0.2.0')
    expect(pluginInstallPath(installed, 'conductor', '/elsewhere')).toBe('/c/cache/agent-kit/conductor/0.1.0')
    const projectOnly = { plugins: { 'lab@kit': [{ scope: 'project', projectPath: '/other', installPath: '/c/lab' }] } }
    expect(pluginInstallPath(projectOnly, 'lab', '/repo')).toBeUndefined()
    expect(pluginInstallPath(installed, 'missing', '/repo')).toBeUndefined()
    expect(pluginInstallPath({ plugins: { 'old@m': { installPath: '/c/old' } } }, 'old', '/repo')).toBe('/c/old')
    expect(pluginInstallPath('garbage', 'conductor', '/repo')).toBeUndefined()
  })

  test("a plugin's agents are its agents/ folder plus what its manifest lists", () => {
    expect(pluginAgentPaths({})).toEqual(['agents'])
    expect(pluginAgentPaths({ agents: ['./skills/a/implementer.md', './more/'] })).toEqual(['agents', 'skills/a/implementer.md', 'more'])
    expect(pluginAgentPaths({ agents: './custom' })).toEqual(['agents', 'custom'])
    expect(pluginAgentPaths({ agents: ['../x.md', '/abs/x.md', './a/../../x.md', 'bare.md', './ok.md'] })).toEqual(['agents', 'ok.md'])
    expect(pluginAgentPaths(null)).toEqual(['agents'])
  })

  test('changed files are the porcelain lines a snapshot did not have', () => {
    expect(newChanges([' M a.ts'], ' M a.ts\n?? b.ts\n M c.ts\n')).toBe(2)
    expect(newChanges([], '')).toBe(0)
  })
})

describe('branch health', () => {
  test('the branch script output reads as branch, trunk, behind and changed', () => {
    expect(parseBranch('feat/x\norigin/main\n3\n      2\n')).toEqual({ branch: 'feat/x', trunk: 'origin/main', behind: 3, changed: 2 })
    expect(parseBranch('feat/x\norigin/main\n\n0\n')).toEqual({ branch: 'feat/x', trunk: 'origin/main', changed: 0 })
    expect(parseBranch('')).toBeUndefined()
    expect(parseBranch('feat/x\norigin/main\n0\n0\ngit@github.com:wedgey/agent-kit.git\n')).toEqual({
      branch: 'feat/x',
      trunk: 'origin/main',
      behind: 0,
      changed: 0,
      repo: 'wedgey/agent-kit',
    })
  })
})
