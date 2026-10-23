import { expect, mock, test } from 'claude-code/testing'
import type { AgentStatus, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'session-activity',
  props: {
    title: 'Session activity',
    isFocused: false,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('a backgrounded command shows as a running row; stop takes two presses and calls TaskStop', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const stopped: string[] = []
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
    text: 'Command running in background with ID: b1. Output is being written to: /t/tasks/b1.output',
  }))
  on('tool.call', { tool: 'TaskStop' }, (_$, e) => {
    stopped.push(e.task_id ?? '')
    return { result: { message: 'stopped', task_id: 'b1', task_type: 'local_bash' }, text: 'stopped' }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))

  await $.tool.call({ tool: 'Bash', command: 'pnpm dev', description: 'Start the dev server', run_in_background: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-activity', surface, ...PANE })
    expect(await ui.find({ type: 'Button', text: /Start the dev server/ })).toBeDefined()
    expect(await ui.find({ key: 'shell:b1:stop', text: 'stop' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  await ui.press({ key: 'shell:b1:stop' })
  expect(await ui.find({ key: 'shell:b1:stop', text: 'confirm stop?' })).toBeDefined()
  expect(stopped).toEqual([])

  await ui.press({ key: 'shell:b1:stop' })
  expect(stopped).toEqual(['b1'])
  expect(await ui.find({ key: 'shell:b1:stop' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^\s*stopped · ran/ })).toBeDefined()
})

test('a task notification marks the row failed with its exit code', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b2' },
    text: 'Command running in background with ID: b2. Output is being written to: /t/tasks/b2.output',
  }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('prompt.submit', () => ({ text: '' }))

  await $.tool.call({ tool: 'Bash', command: 'pnpm build', run_in_background: true })
  await $.prompt.submit({
    text: '<task-notification>\n<task-id>b2</task-id>\n<status>failed</status>\n<summary>Background command "pnpm build" failed (exit code 2)</summary>\n</task-notification>',
    wait: false,
    origin: { kind: 'task-notification' },
  })

  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /exit 2/ })).toBeDefined()
  expect(await ui.find({ key: 'shell:b2:stop' })).toBeUndefined()
})

test('an agent row shows its model and effort, not its type', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'general-purpose', description: 'Check RLS policies', status: 'running' }] }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('turn.step', async function* (_$, e) {
    const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: e.model }
    yield { kind: 'stop', stopReason: 'end_turn', usage } as const
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as const
  })

  for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 1, agentId: 'a1' })) {
  }
  await $.command.run({ command: 'activity', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect((await ui.find({ key: 'agent:a1:toggle' }))?.text).toMatch(/Check RLS policies/)
  const meta = await ui.find({ type: 'Text', text: /Sonnet 5\.5 · high/ })
  expect(meta?.text).toMatch(/1\.2k tok/)
  expect(meta?.text).not.toMatch(/general-purpose/)
})

test('a completed script leaves the pane two minutes after it ends', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b3' },
    text: 'Command running in background with ID: b3. Output is being written to: /t/tasks/b3.output',
  }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('prompt.submit', () => ({ text: '' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const open = () => $.command.run({ command: 'activity', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

  await $.tool.call({ tool: 'Bash', command: 'pnpm lint', run_in_background: true })
  await $.prompt.submit({
    text: '<task-notification>\n<task-id>b3</task-id>\n<status>completed</status>\n<summary>Background command "pnpm lint" completed (exit code 0)</summary>\n</task-notification>',
    wait: false,
    origin: { kind: 'task-notification' },
  })
  await open()
  let ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Button', text: /pnpm lint/ })).toBeDefined()
  await ui.unmount()

  await clock.advance(121_000)
  await open()
  ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Button', text: /pnpm lint/ })).toBeUndefined()
})

test('a script whose output ends in its exit line shows failed and clears with "clear finished"', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b8' },
    text: 'Command running in background with ID: b8. Output is being written to: /t/tasks/b8.output',
  }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 120, mtimeMs: 0, isLink: false } }))
  on('process.run', (_$, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv[0] === 'tail' ? 'pnpm typecheck\nerror TS2345: nope\n\n[exited with code 8]\n' : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))

  await $.tool.call({ tool: 'Bash', command: 'pnpm typecheck', run_in_background: true })
  await $.command.run({ command: 'activity', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /exit 8/ })).toBeDefined()
  expect(await ui.find({ key: 'shell:b8:stop' })).toBeUndefined()

  await ui.press({ key: 'clear-finished' })
  expect(await ui.find({ type: 'Button', text: /pnpm typecheck/ })).toBeUndefined()
})

test('a running script shows its current CPU and memory', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b9' },
    text: 'Command running in background with ID: b9. Output is being written to: /t/tasks/b9.output',
  }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: 0, isLink: false } }))
  const PS = [
    '  100     1   100  0.0 90000 claude',
    `  200   100   200  0.0  4096 /bin/bash -c source /s.sh && eval 'pnpm dev' < /dev/null`,
    '  201   200   201 80.0 1044480 next-server (v16)',
  ].join('\n')
  on('process.run', (_$, e) => {
    const [cmd, ...args] = e.argv
    const stdout =
      cmd === 'sh' ? `self 50\n   50   100    50  0.0  100 sh -c ps\n${PS}` :
      cmd === 'ps' ? PS :
      cmd === 'cat' ? args.map(f => `${f.split('/')[2]} (x) S 1 1 1 0 -1 0 0 0 0 0 ${f.includes('201') ? Math.floor(clock.now() / 10) : 0} 0 0 0`).join('\n') :
      cmd === 'tail' ? 'ready\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const open = () => $.command.run({ command: 'activity', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

  await $.tool.call({ tool: 'Bash', command: 'pnpm dev', run_in_background: true })
  await open()
  await clock.advance(1000)
  await open()

  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^\s*\d+s · 100% CPU · 1\.0GB$/ })).toBeDefined()
})

test('a command a PreToolUse hook rewrote is found by the command that ran', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('classic.PreToolUse', { tool: 'Bash' }, (_$, e) => ({ allow: true, updatedInput: { ...e, command: `rtk ${e.command}` } }))
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'r1' },
    text: 'Command running in background with ID: r1. Output is being written to: /t/tasks/r1.output',
  }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: 0, isLink: false } }))
  const PS = [
    '  100     1   100  0.0 90000 claude',
    `  200   100   200  0.0  4096 /bin/bash -c source /s.sh && eval 'rtk git log' < /dev/null`,
  ].join('\n')
  on('process.run', (_$, e) => {
    const stdout = e.argv[0] === 'sh' ? `self 50\n   50   100    50  0.0  100 sh -c ps\n${PS}` : e.argv[0] === 'ps' ? PS : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const open = () => $.command.run({ command: 'activity', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

  await $.tool.call({ tool: 'Bash', command: 'git log', run_in_background: true })
  await open()
  await clock.advance(11_000)
  await open()

  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /process not found/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /% CPU/ })).toBeDefined()
  expect((await ui.find({ key: 'shell:r1:toggle' }))?.text).toMatch(/^(?!.*rtk).*git log/)
})


test('under 46 columns a script is one line: title, CPU or outcome, and a ■ stop', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'n1' },
    text: 'Command running in background with ID: n1. Output is being written to: /t/tasks/n1.output',
  }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.tool.call({ tool: 'Bash', command: 'pnpm test:e2e:chromium', description: 'Run editor e2e specs for #487', run_in_background: true })

  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 40 } })
  expect((await ui.find({ key: 'shell:n1:toggle' }))?.text).toMatch(/Run editor e2e specs for #487/)
  expect(await ui.find({ key: 'shell:n1:stop', text: '■' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^0s$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\s+0s/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: 'stop all' })).toBeDefined()

  await ui.press({ key: 'shell:n1:stop' })
  expect(await ui.find({ key: 'shell:n1:stop', text: 'stop?' })).toBeDefined()
})

test('stopped monitors collapse into one row that expands on show', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  let n = 0
  on('tool.call', { tool: 'Monitor' }, () => ({ result: { taskId: `m${++n}`, timeoutMs: 300000 }, text: 'Monitor started' }))
  on('tool.call', { tool: 'TaskStop' }, () => ({ result: { message: 'stopped', task_id: 'x', task_type: 'monitor' }, text: 'stopped' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))

  for (let i = 0; i < 3; i++) {
    await $.tool.call({ tool: 'Monitor', description: 'Wait for e2e-443b results', timeout_ms: 300000, command: "until grep -q '^DONE' /t/e2e-443b.log; do sleep 5; done" })
  }
  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  for (const id of ['m1', 'm2', 'm3']) {
    await ui.press({ key: `shell:${id}:stop` })
    await ui.press({ key: `shell:${id}:stop` })
  }

  expect((await ui.find({ key: 'group:stopped-monitors:toggle' }))?.text).toMatch(/3 stopped monitors/)
  expect(await ui.find({ key: 'shell:m1:toggle' })).toBeUndefined()
  await ui.press({ key: 'group:stopped-monitors:show' })
  expect(await ui.find({ key: 'shell:m1:toggle' })).toBeDefined()
})

const STEPS = [
  { content: 'Map the subsystem', status: 'completed' },
  { content: 'Build in small units', status: 'in_progress' },
  { content: 'Open the PR', status: 'pending' },
  { content: 'Measure routing', status: 'skipped', note: 'not asked' },
] as const

type Effort = 'low' | 'medium' | 'high'

const writeTodos = ($: Engine, input: Record<string, unknown>) =>
  $.tool.call({ tool: 'mcp__session-activity__todos', ...input } as unknown as Parameters<Engine['tool']['call']>[0])

const spawn = ($: Engine, description: string, subagentType: string, extra: { model?: string; resume?: { agentId: string } } = {}) =>
  $.agent.spawn({
    tool_use_id: `u-${description}-${Math.random()}`,
    prompt: 'brief',
    description,
    subagentType,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
    ...extra,
  } as unknown as Parameters<Engine['agent']['spawn']>[0])

const openPane = ($: Engine) =>
  $.command.run({ command: 'activity', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

type Host = {
  sessionId?: string
  store?: Record<string, unknown>
  statuses?: (string | undefined)[]
  node?: (args: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr?: string } | undefined> | { exitCode: number; stdout: string; stderr?: string } | undefined
  // `ps` rows; the pane's own `sh` (pid 50) is a child of pid 100.
  ps?: string
  stats?: string[]
  claude?: (args: readonly string[]) => { exitCode: number; stdout: string; stderr?: string } | undefined
  panes?: () => { id: string; isShown: boolean }[]
}

function quietHost(
  on: On,
  files: Record<string, string> = {},
  status: string[] = [''],
  env: Record<string, string> = { HOME: '/home/me' },
  branch = 'feat/x\norigin/main\n2\n1\n',
  links: Record<string, string> = {},
  host: Host = {},
) {
  const store = host.store ?? {}
  on('session.id', () => ({ value: host.sessionId ?? 's1' }))
  on('store.get', (_$, e) => ({ value: store[e.key] }))
  on('store.set', (_$, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  // A symbolic link: a path under `from` lands under `to`.
  const real = (path: string) => {
    for (const [from, to] of Object.entries(links)) if (path === from || path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`
    return path
  }
  on('ui.panes', () => ({ value: (host.panes?.() ?? []) as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_$, e) => {
    host.statuses?.push(e.text)
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/repo' }))
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('fs.read', (_$, e) => {
    const text = files[real(e.path)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.list', (_$, e) => {
    const dir = real(e.path)
    const names = Object.keys(files).filter(f => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes('/'))
    return { value: names.map(f => ({ name: f.slice(dir.length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', (_$, e) => {
    host.stats?.push(e.path)
    const to = real(e.path)
    const text = files[to]
    if (text === undefined && !Object.keys(files).some(f => f.startsWith(`${to}/`))) throw new Error('ENOENT')
    const kind = text === undefined ? ('dir' as const) : ('file' as const)
    return { value: { kind, size: text?.length ?? 0, mtimeMs: 0, isLink: to !== e.path, ...(e.resolve ? { realPath: to } : {}) } }
  })
  on('process.run', async (_$, e) => {
    const ran = e.argv[0] === 'node' ? await host.node?.(e.argv.slice(1)) : e.argv[0] === 'claude' ? host.claude?.(e.argv.slice(1)) : undefined
    if (ran !== undefined) return { value: { stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...ran } }
    const isSelf = e.argv[0] === 'sh' && e.argv[2]?.startsWith('echo "self')
    const stdout =
      e.argv[0] === 'git' ? (status.length > 1 ? status.shift()! : status[0]!) :
      host.ps !== undefined && isSelf ? `self 50\n   50   100    50  0.0  100 sh -c ps\n${host.ps}` :
      host.ps !== undefined && e.argv[0] === 'ps' ? host.ps :
      e.argv[0] === 'sh' ? branch : ''
    return { value: { exitCode: e.argv[0] === 'gh' ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('turn.step', async function* (_$, e) {
    const usage = { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: e.model }
    yield { kind: 'stop', stopReason: 'end_turn', usage } as const
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as const
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('tool.call', { tool: /^SubagentHandback$/ }, () => ({ result: 'Report delivered to your caller.', text: 'Report delivered to your caller.' }))
}

async function runTurn($: Engine, agentId: string, model: string, effort: Effort, answer = '') {
  await $.turn.start({ turnId: `t-${agentId}`, agentId, text: '' })
  for await (const _chunk of $.turn.step({ turnId: `t-${agentId}`, index: 0, model, effort, messageCount: 1, agentId })) {
  }
  const usage = { input_tokens: 400, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model }
  await $.turn.complete({ turnId: `t-${agentId}`, agentId, answer, durationMs: 1, isAborted: false, reason: 'answer', usage })
}

test('the todos tool draws the list with its title, progress, branch and skipped reason', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  quietHost(on)
  on('agent.list', () => ({ value: [] }))

  const saved = await writeTodos($, { title: 'feature', link: 'https://github.com/o/r/issues/512', items: STEPS })
  expect(saved.result).toMatch(/Saved 4 items, 2 done/)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-activity', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /FEATURE · 2 of 4 done/ })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: '#512' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'feat/x · 2 behind main · 1 changed · no PR' })).toBeDefined()
    expect(await ui.find({ key: 'todo:Build in small units:toggle' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'skip: not asked' })).toBeUndefined()
  await ui.press({ key: 'todos:done' })
  expect(await ui.find({ type: 'Text', text: 'skip: not asked' })).toBeDefined()
})

test('the todos tool refuses a bad status, and a subagent, and keeps the list it had', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  quietHost(on)
  on('agent.list', () => ({ value: [] }))
  await writeTodos($, { items: STEPS })
  expect((await writeTodos($, { items: [{ content: 'x', status: 'done' }] })).result).toMatch(/Not saved: .*status/)
  expect((await writeTodos($, { items: [{ content: 'mine', status: 'pending' }], agentId: 'd1' })).result).toMatch(/Not saved: only the main conversation/)
  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /TODOS · 2 of 4 done/ })).toBeDefined()
})

test('an agent sits under the step in progress when it was spawned, with its verdict; a finished step folds it', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  quietHost(on, { '/home/me/.claude/agents/conductor-editor.md': '---\nmodel: haiku\neffort: low\ndisallowedTools: Agent\n---\n' })
  let status: AgentStatus = 'running'
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'conductor-editor', description: 'Rename atoms', status }] }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))

  await writeTodos($, { items: STEPS })
  await spawn($, 'Rename atoms', 'conductor-editor')
  await runTurn($, 'a1', 'claude-haiku-5-5', 'low', 'STATUS     PASS\nDID  lib.ts')
  await openPane($)

  let ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect((await ui.find({ key: 'agent:a1:toggle' }))?.text).toMatch(/editor {2}Rename atoms/)
  expect(await ui.find({ type: 'Text', text: 'PASS' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Haiku 5\.5 · low ✓/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /OTHER AGENTS/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /SPEND · Haiku 5\.5 500/ })).toBeDefined()
  await ui.unmount()

  status = 'completed'
  await writeTodos($, { items: STEPS.map(s => (s.content === 'Build in small units' ? { ...s, status: 'completed' } : s)) })
  await openPane($)
  await openPane($)
  ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  await ui.press({ key: 'todos:done' })
  expect(await ui.find({ type: 'Text', text: '1 agent ✓' })).toBeDefined()
  expect(await ui.find({ key: 'agent:a1:toggle' })).toBeUndefined()
  await ui.press({ key: 'todo:Build in small units:toggle' })
  expect(await ui.find({ key: 'agent:a1:toggle' })).toBeDefined()
})

test('a resumed agent keeps its step and verdict and is no escalation', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  quietHost(on)
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'general-purpose', description: 'Review', status: 'completed' }] }))
  on('agent.spawn', () => ({ model: 'opus', agentId: 'a1' }))

  await writeTodos($, { items: STEPS })
  await spawn($, 'Review', 'general-purpose')
  await runTurn($, 'a1', 'claude-opus-5-5', 'high', 'STATUS PASS')
  await writeTodos($, { items: [...STEPS.slice(0, 2).map(s => ({ ...s, status: 'completed' })), { content: 'Open the PR', status: 'in_progress' }] })
  await spawn($, 'Review', 'general-purpose', { resume: { agentId: 'a1' } })
  await runTurn($, 'a1', 'claude-opus-5-5', 'high', 'Thanks, noted.')
  await openPane($)

  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  await ui.press({ key: 'todos:done' })
  expect(await ui.find({ type: 'Text', text: '1 agent ✓' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /escalated/ })).toBeUndefined()
  await ui.press({ key: 'todo:Build in small units:toggle' })
  expect(await ui.find({ type: 'Text', text: 'PASS' })).toBeDefined()
})

test('a delegate on another model than its definition asks for is flagged, and so is a read-only one that changed the tree', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  quietHost(
    on,
    { '/repo/.claude/agents/conductor-reviewer.md': '---\nmodel: opus\neffort: high\ndisallowedTools: Agent, Edit, Write\n---\n' },
    [' M a.ts\n', ' M a.ts\n?? b.ts\n', ' M a.ts\n?? b.ts\n'],
  )
  on('agent.list', () => ({ value: [{ id: 'r1', type: 'conductor-reviewer', description: 'Review unit 1', status: 'completed' }] }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'r1' }))

  await spawn($, 'Review unit 1', 'conductor-reviewer')
  await runTurn($, 'r1', 'claude-sonnet-5-5', 'medium', 'STATUS PASS')
  await spawn($, 'Review unit 1', 'conductor-reviewer', { resume: { agentId: 'r1' } })
  await runTurn($, 'r1', 'claude-sonnet-5-5', 'medium', 'Noted.')
  await openPane($)

  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /AGENTS · 0 running/ })).toBeDefined()
  expect((await ui.find({ key: 'agent:r1:toggle' }))?.text).toMatch(/^⚠/)
  expect(await ui.find({ type: 'Text', text: /⚠ ran Sonnet 5\.5 medium; its definition asks for opus high/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⚠ 1 file changed in the tree while this read-only agent ran/ })).toBeDefined()
})

test('the same brief spawned again on another model is an escalation; on the same model it is not', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  quietHost(on)
  const agents: { id: string; type: string; description: string; status: AgentStatus }[] = []
  on('agent.list', () => ({ value: agents }))
  let next = ''
  on('agent.spawn', () => ({ model: 'x', agentId: next }))

  const run = async (id: string, description: string, model: string, effort: Effort, answer: string, spawnModel?: string) => {
    next = id
    await spawn($, description, 'general-purpose', spawnModel ? { model: spawnModel } : {})
    agents.push({ id, type: 'general-purpose', description, status: 'completed' })
    await runTurn($, id, model, effort, answer)
    await openPane($)
    await openPane($)
  }
  await run('e1', 'Fix tsc', 'claude-haiku-5-5', 'low', 'STATUS BLOCKED')
  await run('e2', 'Fix tsc', 'claude-sonnet-5-5', 'medium', 'STATUS PASS', 'sonnet')
  await run('v1', 'Review branch', 'claude-opus-5-5', 'high', 'STATUS ISSUES', 'opus')
  await run('v2', 'Review branch', 'claude-opus-5-5', 'high', 'STATUS PASS', 'opus')

  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect(await ui.findAll({ type: 'Text', text: /↑ escalated/ })).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /↑ escalated from Haiku 5\.5 \(BLOCKED\)/ })).toBeDefined()
})


const QUEUE = [
  { content: 'wedgey/agent-kit#7 Ship the role agents', status: 'completed' },
  { content: 'Conductor as a root plugin: skill, agents, queue, hooks', ticket: 'wedgey/agent-kit#9', status: 'in_progress' },
  { content: '#554 Rerun failed e2e once + flaky ledger', status: 'pending' },
  { content: 'Session-activity pane: now/next split, per-item ticket', status: 'pending' },
  { content: 'https://github.com/wedgey/contexory/pull/560 Queue status line', status: 'pending' },
  { content: '#561 Watch the merge queue', status: 'pending' },
  { content: 'Measure routing', status: 'skipped', note: 'not asked' },
] as const
const LINK = 'https://github.com/wedgey/contexory/issues/550'

const ROOT = '/home/me/.claude/plugins/cache/agent-kit/conductor/0.1.0'
const BINDINGS = 'skills/conductor/bindings/claude-code-agents'
const installed = (plugins: Record<string, string>) =>
  JSON.stringify({ version: 2, plugins: Object.fromEntries(Object.entries(plugins).map(([k, root]) => [k, [{ scope: 'user', installPath: root }]])) })
const conductorTree = (configDir = '/home/me/.claude', root = ROOT) => ({
  [`${configDir}/plugins/installed_plugins.json`]: installed({ 'conductor@agent-kit': root }),
  [`${root}/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'conductor', agents: [`./${BINDINGS}/implementer.md`, `./${BINDINGS}/reviewer.md`] }),
  [`${root}/${BINDINGS}/implementer.md`]: '---\nname: implementer\nmodel: sonnet\neffort: medium\ndisallowedTools: Agent\n---\n',
  [`${root}/${BINDINGS}/reviewer.md`]: '---\nname: reviewer\nmodel: opus\neffort: high\ndisallowedTools: Agent, Edit, Write\n---\n',
})

// The drawing as plain text: a row Box joins its children, a column Box stacks them, a Box width pads.
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  const el = node as { type?: string; props?: Record<string, unknown>; children?: unknown[] } | null
  if (!el?.type) return ''
  const props = el.props ?? {}
  if (el.type === 'Link') return String(props.label ?? '')
  if (el.type === 'Button' && props.label !== undefined) return props.plain ? String(props.label) : `[${String(props.label)}]`
  const parts = (el.children ?? []).map(textOf).filter(p => p !== '')
  if (el.type !== 'Box') return parts.join('')
  const out = props.flexDirection === 'row' ? parts.join(props.gap ? ' ' : '') : parts.join('\n')
  return typeof props.width === 'number' ? out.padEnd(props.width) : out
}

test('todos draw as NOW, NEXT and a folded DONE, each item behind an aligned ticket column', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  quietHost(on, conductorTree(), [''], { HOME: '/home/me' }, 'feat/conductor-queue\norigin/main\n0\n3\ngit@github.com:wedgey/contexory.git\n')
  on('agent.list', () => ({ value: [{ id: 'r1', type: 'conductor:reviewer', description: 'Review the queue', status: 'running' }] }))
  on('agent.spawn', () => ({ model: 'opus', agentId: 'r1' }))

  await writeTodos($, { title: 'conductor queue plugin', link: LINK, items: QUEUE })
  await spawn($, 'Review the queue', 'conductor:reviewer')
  await runTurn($, 'r1', 'claude-opus-5-5', 'high')
  await openPane($)

  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 72 } })
  const drawn = textOf(await ui.find({ type: 'Box' }))
  const lines = drawn.split('\n')
  const at = (pattern: RegExp) => lines.findIndex(l => pattern.test(l))
  expect(at(/^NOW$/)).toBeLessThan(at(/Conductor as a root plugin/))
  expect(at(/Conductor as a root plugin/)).toBeLessThan(at(/reviewer {2}Review the queue/))
  expect(at(/reviewer {2}Review the queue/)).toBeLessThan(at(/^NEXT$/))
  expect(lines.slice(at(/^NEXT$/) + 1, at(/^DONE/))).toEqual([
    '○ #554        Rerun failed e2e once + flaky ledger',
    '○             Session-activity pane: now/next split, per-item ticket',
    '○ #560        Queue status line',
    '○ #561        Watch the merge queue',
  ])
  expect(lines[at(/^DONE/)]).toBe('DONE · 2 [show]')
  expect(await ui.find({ key: 'todo:Measure routing:toggle' })).toBeUndefined()

  expect(await ui.find({ type: 'Link', text: 'agent-kit#9' })).toMatchObject({ props: { href: 'https://github.com/wedgey/agent-kit/issues/9' } })
  expect(await ui.find({ type: 'Link', text: '#554' })).toMatchObject({ props: { href: 'https://github.com/wedgey/contexory/issues/554' } })
  expect(await ui.find({ type: 'Link', text: '#560' })).toMatchObject({ props: { href: 'https://github.com/wedgey/contexory/pull/560' } })
  expect((await ui.find({ key: 'todo:#554 Rerun failed e2e once + flaky ledger:toggle' }))?.text).toBe('Rerun failed e2e once + flaky ledger')
  expect(await ui.find({ type: 'Text', text: /Opus 5\.5 · high ✓/ })).toBeDefined()

  await ui.press({ key: 'todos:done' })
  expect(await ui.find({ key: 'todos:done', text: 'hide' })).toBeDefined()
  expect((await ui.find({ key: 'todo:wedgey/agent-kit#7 Ship the role agents:toggle' }))?.text).toBe('Ship the role agents')
  expect(await ui.find({ type: 'Text', text: 'skip: not asked' })).toBeDefined()
  await ui.press({ key: 'todos:done' })
  expect(await ui.find({ key: 'todo:Measure routing:toggle' })).toBeUndefined()
})

test('the status line leads with the NOW item and its ticket', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const statuses: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  await writeTodos($, { link: LINK, items: QUEUE })
  expect(statuses.at(-1)).toBe('◆ 2/7 agent-kit#9 Conductor as a root plugin: skill, agents, queue, hooks')
})

test('under 46 columns the NOW item and the first NEXT item stay, ticket inline; the rest folds into one line', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  quietHost(on)
  on('agent.list', () => ({ value: [] }))
  await writeTodos($, { link: LINK, items: QUEUE })
  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 40 } })
  const lines = textOf(await ui.find({ type: 'Box' })).split('\n')
  expect(lines.slice(2)).toEqual([
    '◐ agent… Conductor as a root plugin: skill, agents, queue, hooks 0s',
    '○ #554 Rerun failed e2e once + flaky ledger',
    '[+3 more] DONE · 2 [show]',
  ])
  // The ticket is cut to 6 columns, so 40 columns keep at least 20 for the text.
  expect(lines[2]!.indexOf('Conductor')).toBeLessThanOrEqual(40 - 20)
  expect(await ui.find({ type: 'Link', text: 'agent…' })).toMatchObject({ props: { href: 'https://github.com/wedgey/agent-kit/issues/9' } })

  await ui.press({ key: 'todos:toggle' })
  expect(await ui.find({ key: 'todo:#561 Watch the merge queue:toggle' })).toBeDefined()
  expect(await ui.find({ key: 'todos:toggle', text: 'fewer' })).toBeDefined()
  expect(await ui.find({ key: 'todo:Measure routing:toggle' })).toBeUndefined()
  await ui.press({ key: 'todos:done' })
  expect(await ui.find({ key: 'todo:Measure routing:toggle' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'skip' })).toBeDefined()
})

test('a done item stays out of the fold while an agent under it is running or needs a look, counted on the DONE line', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  quietHost(on)
  const agents: { id: string; type: string; description: string; status: AgentStatus }[] = [
    { id: 'b1', type: 'conductor:reviewer', description: 'Review A', status: 'completed' },
    { id: 'b2', type: 'general-purpose', description: 'Watch B', status: 'running' },
  ]
  on('agent.list', () => ({ value: agents }))
  let next = ''
  on('agent.spawn', () => ({ model: 'opus', agentId: next }))
  const items = (statuses: Record<string, string>) => ['A', 'B', 'C'].map(content => ({ content, status: statuses[content] ?? 'completed' }))

  await writeTodos($, { items: items({ A: 'in_progress', B: 'pending' }) })
  next = 'b1'
  await spawn($, 'Review A', 'conductor:reviewer')
  await runTurn($, 'b1', 'claude-opus-5-5', 'high', 'STATUS ISSUES')
  await writeTodos($, { items: items({ B: 'in_progress' }) })
  next = 'b2'
  await spawn($, 'Watch B', 'general-purpose')
  await writeTodos($, { items: items({}) })
  await openPane($)

  for (const bodyColumns of [120, 40]) {
    const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns } })
    expect(await ui.find({ type: 'Text', text: 'DONE · 3 · 1 ✗ · 1 running' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 agent ✗' })).toBeDefined()
    expect(await ui.find({ key: 'agent:b1:toggle' })).toBeDefined()
    expect(await ui.find({ key: 'agent:b2:toggle' })).toBeDefined()
    expect(await ui.find({ key: 'todo:C:toggle' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a plugin agent listed in its manifest gets the routing check and the read-only guard', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  quietHost(on, conductorTree(), [' M a.ts\n', ' M a.ts\n?? b.ts\n'])
  on('agent.list', () => ({ value: [{ id: 'r1', type: 'conductor:reviewer', description: 'Review unit 1', status: 'completed' }] }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'r1' }))

  await spawn($, 'Review unit 1', 'conductor:reviewer')
  await runTurn($, 'r1', 'claude-sonnet-5-5', 'medium', 'STATUS PASS')
  await openPane($)

  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect((await ui.find({ key: 'agent:r1:toggle' }))?.text).toMatch(/^⚠ reviewer {2}Review unit 1/)
  expect(await ui.find({ type: 'Text', text: /⚠ ran Sonnet 5\.5 medium; its definition asks for opus high/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⚠ 1 file changed in the tree while this read-only agent ran/ })).toBeDefined()
})

async function routedRow(on: On, $: Engine, type: string, files: Record<string, string>, env?: Record<string, string>, links?: Record<string, string>) {
  mock.clock(on, { now: 1_000_000 })
  quietHost(on, files, [''], env, undefined, links)
  on('agent.list', () => ({ value: [{ id: 'p1', type, description: 'Run it', status: 'completed' }] }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'p1' }))
  await spawn($, 'Run it', type)
  await runTurn($, 'p1', 'claude-haiku-5-5', 'low', 'STATUS PASS')
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  return (await ui.find({ type: 'Text', text: /^\s*Haiku 5\.5 · low/ }))?.text ?? ''
}

const RUNNER = '---\nname: runner\nmodel: haiku\neffort: low\n---\n'

test("a plugin agent in the default agents/ folder is found by its frontmatter name, not its file name", async ($, on) => {
  const files = {
    '/home/me/.claude/plugins/installed_plugins.json': installed({ 'lab@kit': '/plugins/lab' }),
    '/plugins/lab/.claude-plugin/plugin.json': '{ "name": "lab" }',
    '/plugins/lab/agents/other.md': '---\nname: other\nmodel: opus\n---\n',
    '/plugins/lab/agents/run-things.md': RUNNER,
  }
  expect(await routedRow(on, $, 'lab:runner', files)).toMatch(/low ✓/)
})

test('an agent of a plugin that is not installed gets no routing check and no warning', async ($, on) => {
  const row = await routedRow(on, $, 'ghost:runner', { '/home/me/.claude/plugins/installed_plugins.json': installed({ 'lab@kit': '/plugins/lab' }) })
  expect(row).toMatch(/Haiku 5\.5 · low ·/)
  expect(row).not.toMatch(/✓/)
})

test('CLAUDE_CONFIG_DIR moves where installed plugins are read from', async ($, on) => {
  const files = {
    '/home/me/.claude/plugins/installed_plugins.json': installed({ 'lab@kit': '/decoy' }),
    '/decoy/agents/runner.md': '---\nname: runner\nmodel: opus\neffort: high\n---\n',
    '/cfg/plugins/installed_plugins.json': installed({ 'lab@kit': '/plugins/lab' }),
    '/plugins/lab/agents/runner.md': RUNNER,
  }
  expect(await routedRow(on, $, 'lab:runner', files, { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/cfg' })).toMatch(/low ✓/)
})

test('manifest agent paths outside the plugin, by .., absolute path, symbolic link or size, are never read', async ($, on) => {
  // Each file would route the row (✓) if it were read.
  const outside = RUNNER
  const files = {
    '/home/me/.claude/plugins/installed_plugins.json': installed({ 'lab@kit': '/plugins/lab' }),
    '/plugins/lab/.claude-plugin/plugin.json': JSON.stringify({ agents: ['../evil/runner.md', '/evil/runner.md', './linked/runner.md', './big.md'] }),
    '/plugins/evil/runner.md': outside,
    '/evil/runner.md': outside,
    '/plugins/lab/big.md': `${outside}${'x'.repeat(300 * 1024)}`,
  }
  expect(await routedRow(on, $, 'lab:runner', files, undefined, { '/plugins/lab/linked': '/evil' })).not.toMatch(/✓/)
})

const handBack = ($: Engine, agentId: string, message: string) =>
  $.tool.call({ tool: 'SubagentHandback', message, agentId } as unknown as Parameters<Engine['tool']['call']>[0])

test('a report handed back through SubagentHandback gives the verdict, and the run reads as done though the list still says running', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  quietHost(on)
  on('agent.list', () => ({ value: [{ id: 'h1', type: 'conductor:implementer', description: 'Build unit 2', status: 'running' }] }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'h1' }))

  await spawn($, 'Build unit 2', 'conductor:implementer')
  await runTurn($, 'h1', 'claude-sonnet-5-5', 'medium', 'Working on it.')
  await openPane($)
  let ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'AGENTS · 0 running' })).toBeDefined()
  await ui.unmount()

  await spawn($, 'Build unit 2', 'conductor:implementer', { resume: { agentId: 'h1' } })
  await $.turn.start({ turnId: 't-h1b', agentId: 'h1', text: 'go on' })
  await openPane($)
  await openPane($)
  ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'AGENTS · 1 running' })).toBeDefined()
  await ui.unmount()

  await handBack($, 'h1', 'STATUS     ISSUES\nDID  a.ts')
  await $.turn.complete({ turnId: 't-h1b', agentId: 'h1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  await openPane($)
  await openPane($)
  ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'ISSUES' })).toBeDefined()
  expect((await ui.find({ key: 'agent:h1:toggle' }))?.text).toMatch(/^✓ implementer {2}Build unit 2/)
  expect(await ui.find({ key: 'agent:h1:stop' })).toBeUndefined()
})

test('a resumed delegate shows the verdict of its newest run', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  quietHost(on)
  on('agent.list', () => ({ value: [{ id: 'v1', type: 'conductor:reviewer', description: 'Review unit 3', status: 'completed' }] }))
  on('agent.spawn', () => ({ model: 'opus', agentId: 'v1' }))

  await spawn($, 'Review unit 3', 'conductor:reviewer')
  await runTurn($, 'v1', 'claude-opus-5-5', 'high', 'STATUS ISSUES')
  await spawn($, 'Review unit 3', 'conductor:reviewer', { resume: { agentId: 'v1' } })
  await runTurn($, 'v1', 'claude-opus-5-5', 'high', 'STATUS PASS')
  await openPane($)

  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: 'PASS' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ISSUES' })).toBeUndefined()
})

const DAY = 86_400_000

test('the todo list is kept in the store under the session, and a restart of that session gets it back', async ($, on) => {
  mock.clock(on, { now: 10 * DAY })
  const store: Record<string, unknown> = {}
  quietHost(on, {}, [''], undefined, undefined, {}, { store, sessionId: 's1' })
  on('agent.list', () => ({ value: [] }))
  await writeTodos($, { title: 'feature', items: STEPS })
  expect(store['todos:s1']).toEqual({ savedAt: 10 * DAY, todos: { title: 'feature', items: expect.any(Array) } })
  expect((store['todos:s1'] as { todos: { items: unknown[] } }).todos.items).toHaveLength(4)
})

const SAVED = { savedAt: 10 * DAY - 60_000, todos: { title: 'feature', items: [{ content: 'Build in small units', status: 'in_progress', startedAt: 10 * DAY - 60_000 }] } }
const startSession = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

test('a new process of the same session restores the stored list; entries older than 7 days are pruned', async ($, on) => {
  mock.clock(on, { now: 10 * DAY })
  const store: Record<string, unknown> = { 'todos:s1': SAVED, 'todos:old': { ...SAVED, savedAt: 2 * DAY }, other: 1 }
  quietHost(on, {}, [''], undefined, undefined, {}, { store, sessionId: 's1' })
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await startSession($)
  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /FEATURE · 0 of 1 done/ })).toBeDefined()
  expect(Object.keys(store).sort()).toEqual(['other', 'todos:s1'])
})

test('another session gets no stored list', async ($, on) => {
  mock.clock(on, { now: 10 * DAY })
  quietHost(on, {}, [''], undefined, undefined, {}, { store: { 'todos:s1': SAVED }, sessionId: 's2' })
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await startSession($)
  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /FEATURE/ })).toBeUndefined()
})

const CONDUCTOR = '/plugins/conductor'
const QUEUE_TOOL = `${CONDUCTOR}/skills/conductor/tools/queue.mjs`
// Captured from conductor's queue.mjs status --json: an orphan's lock holder unknown, an "unknown" holder unread.
const REAL_STATUS = {
  "protocol": 1,
  "queues": [
    {
      "name": "e2e",
      "slots": 1,
      "slotsSource": "files",
      "holders": [
        {
          "slot": 0,
          "pid": null,
          "cwd": null,
          "command": null,
          "ageMs": null,
          "state": "orphan",
          "cpuPct": null,
          "memKb": null
        }
      ],
      "waiters": []
    },
    {
      "name": "tests",
      "slots": 2,
      "slotsSource": "records",
      "holders": [
        {
          "slot": 0,
          "pid": 500788,
          "cwd": "/tmp",
          "command": "sh -c while :; do :; done",
          "ageMs": 16346,
          "state": "busy",
          "cpuPct": 101,
          "memKb": 50152
        },
        {
          "slot": 1,
          "pid": 501210,
          "cwd": "/tmp",
          "command": "sleep 60",
          "ageMs": 8745,
          "state": "idle",
          "cpuPct": 0,
          "memKb": 50544
        }
      ],
      "waiters": [
        {
          "ticket": "gate-1792752271593-501700",
          "pid": 501700,
          "cwd": "/tmp",
          "command": "sleep 32",
          "priority": "gate",
          "rank": 0,
          "waitedMs": 723
        },
        {
          "ticket": "normal-1792752271593-501699",
          "pid": 501699,
          "cwd": "/tmp",
          "command": "sleep 31",
          "priority": "normal",
          "rank": 1,
          "waitedMs": 723
        }
      ]
    }
  ],
  "machine": {
    "cores": 8,
    "load1": 1.39,
    "memAvailKb": 17536892,
    "memTotalKb": 22581312
  }
}
const REAL_STATUS_UNKNOWN = {
  "protocol": 1,
  "queues": [
    {
      "name": "e2e",
      "slots": 1,
      "slotsSource": "files",
      "holders": [
        {
          "slot": 0,
          "pid": null,
          "cwd": null,
          "command": null,
          "ageMs": null,
          "state": "orphan",
          "cpuPct": null,
          "memKb": null
        }
      ],
      "waiters": []
    },
    {
      "name": "movetest",
      "slots": 1,
      "slotsSource": "records",
      "holders": [
        {
          "slot": 0,
          "pid": 505839,
          "cwd": "/tmp",
          "command": "sleep 120",
          "ageMs": 1079,
          "state": "idle",
          "cpuPct": 0,
          "memKb": 50512
        }
      ],
      "waiters": [
        {
          "ticket": "normal-1792752352759-505903",
          "pid": 505903,
          "cwd": "/tmp",
          "command": "sleep 41",
          "priority": "normal",
          "rank": 0,
          "waitedMs": 577
        },
        {
          "ticket": "normal-1792752352821-505921",
          "pid": 505921,
          "cwd": "/tmp",
          "command": "sleep 42",
          "priority": "normal",
          "rank": 1,
          "waitedMs": 515
        }
      ]
    },
    {
      "name": "tests",
      "slots": 2,
      "slotsSource": "records",
      "holders": [
        {
          "slot": 0,
          "pid": 500788,
          "cwd": "/tmp",
          "command": "sh -c while :; do :; done",
          "ageMs": 98374,
          "state": "busy",
          "cpuPct": 100,
          "memKb": 50152
        },
        {
          "slot": 1,
          "pid": 504460,
          "cwd": "/tmp",
          "command": "sleep 31",
          "ageMs": 30830,
          "state": "unknown",
          "cpuPct": null,
          "memKb": null
        }
      ],
      "waiters": [
        {
          "ticket": "normal-1792752289603-502597",
          "pid": 502597,
          "cwd": "/tmp",
          "command": "sleep 33",
          "priority": "normal",
          "rank": 0,
          "waitedMs": 64741
        }
      ]
    }
  ],
  "machine": {
    "cores": 8,
    "load1": 1.53,
    "memAvailKb": 17449652,
    "memTotalKb": 22581312
  }
}

// The same shape, with cwds that exercise place and the "you" mark.
const QUEUE_FIXTURE = {
  protocol: 1,
  queues: [
    {
      name: 'tests',
      slots: 2,
      slotsSource: 'env',
      holders: [
        { slot: 0, pid: 123, cwd: '/workspace/.worktrees/q-plain', command: 'pnpm test', ageMs: 240_000, state: 'busy', cpuPct: 340, memKb: 838_861 },
        { slot: 1, pid: 124, cwd: '/repo', command: 'pnpm test:changed', ageMs: 60_000, state: 'idle', cpuPct: 0, memKb: 314_573 },
      ],
      waiters: [
        { ticket: 'w2', pid: 457, cwd: '/repo/apps/web', command: 'pnpm build', priority: 'normal', rank: 1, waitedMs: 5_000 },
        { ticket: 'w1', pid: 456, cwd: '/workspace/.worktrees/rd-441', command: 'pnpm typecheck', priority: 'gate', rank: 0, waitedMs: 65_000 },
      ],
    },
    {
      name: 'e2e',
      slots: 1,
      slotsSource: 'files',
      holders: [{ slot: 0, pid: null, cwd: null, command: null, ageMs: null, state: 'orphan', cpuPct: null, memKb: null }],
      waiters: [],
    },
    {
      name: 'build',
      slots: 1,
      slotsSource: 'records',
      holders: [{ slot: 0, pid: 130, cwd: '/workspace/.worktrees/q-plain', command: 'pnpm build', ageMs: 30_000, state: 'unknown', cpuPct: null, memKb: null }],
      waiters: [],
    },
  ],
  machine: { cores: 8, load1: 12.3, memAvailKb: 8_388_608, memTotalKb: 21_000_000 },
}

type QueueAnswer = { exitCode: number; stdout: string; stderr?: string }

// The session (root 100) runs 124 through its shell 110; 457 and 999, in the same folder, belong to another session.
const QUEUE_PS = [
  '  100     1   100  0.0 90000 claude',
  `  110   100   110  0.0  4096 /bin/bash -c source /s.sh && eval 'pnpm test:changed' < /dev/null`,
  '  124   110   110  0.0  4096 node vitest',
  '  900     1   900  0.0 90000 claude',
  '  457   900   457  0.0  4096 pnpm build',
  '  999   900   999  0.0  4096 pnpm lint',
].join('\n')

function queueHost(
  on: On,
  answers: Record<string, QueueAnswer> = {},
  opts: { isInstalled?: boolean; statuses?: (string | undefined)[]; status?: unknown; installs?: Record<string, string>; hasTool?: boolean; stats?: string[] } = {},
) {
  const calls: string[][] = []
  const installs = opts.installs ?? { 'conductor@agent-kit': CONDUCTOR }
  const files: Record<string, string> =
    opts.isInstalled === false
      ? {}
      : {
          '/home/me/.claude/plugins/installed_plugins.json': installed(installs),
          ...(opts.hasTool === false ? {} : Object.fromEntries(Object.values(installs).map(root => [`${root}/skills/conductor/tools/queue.mjs`, '']))),
        }
  quietHost(on, files, [''], undefined, undefined, {}, {
    statuses: opts.statuses,
    stats: opts.stats,
    ps: QUEUE_PS,
    node: args => {
      if (!args[0]?.endsWith('/skills/conductor/tools/queue.mjs')) return undefined
      calls.push(args.slice(1))
      if (args[1] === 'status') return { exitCode: 0, stdout: JSON.stringify(typeof opts.status === 'function' ? opts.status() : (opts.status ?? QUEUE_FIXTURE)) }
      return answers[args[1] ?? ''] ?? { exitCode: 0, stdout: '{"ok":true}' }
    },
  })
  on('agent.list', () => ({ value: [] }))
  return calls
}

test('the QUEUE section lists holders with their state and waiters in rank order, only runs in this session\'s process tree marked', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const statuses: (string | undefined)[] = []
  queueHost(on, {}, { statuses })
  await writeTodos($, { items: [{ content: 'Ship', status: 'in_progress' }] })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 72 } })
  const lines = textOf(await ui.find({ type: 'Box' })).split('\n')
  const at = lines.findIndex(l => l.startsWith('QUEUE'))
  expect(lines.slice(at, at + 7)).toEqual([
    'QUEUE · tests 2/2 · e2e 1/1 · build 1/1 · load 12 / 8 cores · 8.0G free',
    '● tests  q-plain pnpm test 4m00s 3.4 cores · 819M [stop]',
    '● tests  repo pnpm test:changed you idle 1m00s 0.0 cores · 307M [stop]',
    '● e2e  (process gone) orphan',
    '◌ build  q-plain pnpm build 30s [stop]',
    '○ #1 tests  rd-441 pnpm typecheck gate waiting 1m05s [top] [↑] [↓]',
    '○ #2 tests  web pnpm build waiting 5s [top] [↑] [↓]',
  ])
  expect(await ui.find({ key: 'queue:e2e:0:stop' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'idle' })).toMatchObject({ props: { color: 'warning' } })
  expect(await ui.find({ type: 'Text', text: 'orphan' })).toMatchObject({ props: { color: 'warning' } })
  expect(statuses.at(-1)).toBe('◆ 0/1 Ship · queue 4/4 +2')
})

test('stop asks first: a yes runs queue stop and says what it did, a no or a dismissal runs nothing', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const calls = queueHost(on, { stop: { exitCode: 0, stdout: '{"ok":true,"stopped":3,"killed":1}' } })
  let answer: string | undefined = 'Keep it'
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = (e.questions[0] as { question: string }).question
    asked.push(question)
    return answer === undefined ? { deny: 'dismissed' } : { result: { questions: e.questions, answers: { [question]: answer } } }
  })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })

  await ui.press({ key: 'queue:tests:0:stop' })
  answer = undefined
  await ui.press({ key: 'queue:tests:0:stop' })
  expect(calls.filter(c => c[0] === 'stop')).toEqual([])
  expect(asked[0]).toBe('Stop `pnpm test` in tests slot 0 (q-plain)?')

  answer = 'Stop it'
  await ui.press({ key: 'queue:tests:0:stop' })
  expect(calls.filter(c => c[0] === 'stop')).toEqual([['stop', 'tests', '0']])
  expect(await ui.find({ type: 'Text', text: 'stop tests slot 0: 3 processes stopped, 1 killed' })).toBeDefined()
})

test('a slot that changed hands while the question was open is not stopped', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  let isAsked = false
  const [tests, ...rest] = QUEUE_FIXTURE.queues
  const taken = { ...QUEUE_FIXTURE, queues: [{ ...tests!, holders: [{ ...tests!.holders[0]!, pid: 999, command: 'pnpm lint' }, tests!.holders[1]!] }, ...rest] }
  const calls = queueHost(on, {}, { status: () => (isAsked ? taken : QUEUE_FIXTURE) })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    isAsked = true
    const question = (e.questions[0] as { question: string }).question
    return { result: { questions: e.questions, answers: { [question]: 'Stop it' } } }
  })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  await ui.press({ key: 'queue:tests:0:stop' })
  expect(calls.filter(c => c[0] === 'stop')).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'tests slot 0 changed hands; not stopped' })).toBeDefined()
})

test('a conductor without queue.mjs, or one from another marketplace, runs no queue call', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const reads: string[] = []
  const calls = queueHost(on, {}, { installs: { 'conductor@other': '/plugins/other', 'conductor@agent-kit': '/plugins/old-conductor' }, hasTool: false, stats: reads })
  await openPane($)
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /QUEUE/ })).toBeUndefined()
  expect(calls).toEqual([])
  expect(reads.filter(p => p.endsWith('queue.mjs'))).toEqual(['/plugins/old-conductor/skills/conductor/tools/queue.mjs'])
})

test('an idle queue draws no section and leaves the empty state', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const idle = { ...QUEUE_FIXTURE, queues: QUEUE_FIXTURE.queues.map(q => ({ ...q, holders: [], waiters: [] })) }
  queueHost(on, {}, { status: idle })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /QUEUE/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Nothing running/ })).toBeDefined()
})

test('the move buttons run queue move and say so', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const calls = queueHost(on, { move: { exitCode: 0, stdout: '{"ok":true}' } })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  await ui.press({ key: 'queue:w2:top' })
  await ui.press({ key: 'queue:w1:down' })
  expect(calls.filter(c => c[0] === 'move')).toEqual([
    ['move', 'w2', 'top'],
    ['move', 'w1', 'down'],
  ])
  expect(await ui.find({ type: 'Text', text: 'move pnpm typecheck down: done' })).toBeDefined()
})

test('without the conductor plugin there is no QUEUE section and no queue call', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const calls = queueHost(on, {}, { isInstalled: false })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /QUEUE/ })).toBeUndefined()
  expect(calls).toEqual([])
})

test('under 46 columns the QUEUE section is its header and holders, with waiters counted', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  queueHost(on)
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 40 } })
  const lines = textOf(await ui.find({ type: 'Box' })).split('\n')
  const at = lines.findIndex(l => l.startsWith('QUEUE'))
  expect(lines.slice(at, at + 6)).toEqual([
    'QUEUE · tests 2/2 · e2e 1/1 · build 1/1 · load 12 / 8 cores · 8.0G free',
    '● tests  q-plain pnpm test [■]',
    '● tests  repo pnpm test:changed you idle [■]',
    '● e2e  (process gone) orphan',
    '◌ build  q-plain pnpm build [■]',
    '+2 waiting',
  ])
  expect(await ui.find({ key: 'queue:w1:top' })).toBeUndefined()
})

test("a failed queue command shows the tool's reason, though it exits 1 with nothing on stderr", async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  queueHost(on, {
    move: { exitCode: 1, stdout: '{"ok":false,"reason":"a normal run can\'t pass a gate run"}', stderr: '' },
    stop: { exitCode: 1, stdout: '{"ok":false,"reason":"no live holder in slot 0 of tests"}', stderr: '' },
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = (e.questions[0] as { question: string }).question
    return { result: { questions: e.questions, answers: { [question]: 'Stop it' } } }
  })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE })
  await ui.press({ key: 'queue:w2:up' })
  expect(await ui.find({ type: 'Text', text: "move pnpm build up: not done (a normal run can't pass a gate run)" })).toBeDefined()
  await ui.press({ key: 'queue:tests:0:stop' })
  expect(await ui.find({ type: 'Text', text: 'stop tests slot 0: not done (no live holder in slot 0 of tests)' })).toBeDefined()
})

test('the real status shapes draw with no made-up zeros: an orphan without a process has no stop, an unread holder no usage', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  queueHost(on, {}, { status: REAL_STATUS_UNKNOWN })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 72 } })
  const lines = textOf(await ui.find({ type: 'Box' })).split('\n')
  const at = lines.findIndex(l => l.startsWith('QUEUE'))
  expect(lines.slice(at, at + 8)).toEqual([
    'QUEUE · e2e 1/1 · movetest 1/1 · tests 2/2 · load 2 / 8 cores · 16.6G free',
    '● e2e  (process gone) orphan',
    '● movetest  tmp sleep 120 idle 1s 0.0 cores · 49M [stop]',
    '● tests  tmp sh -c while :; do :; done 1m38s 1.0 cores · 49M [stop]',
    '◌ tests  tmp sleep 31 30s [stop]',
    '○ #1 movetest  tmp sleep 41 waiting 0s [top] [↑] [↓]',
    '○ #2 movetest  tmp sleep 42 waiting 0s [top] [↑] [↓]',
    '○ #1 tests  tmp sleep 33 waiting 1m04s [top] [↑] [↓]',
  ])
  expect(lines.join('\n')).not.toMatch(/0\.0G/)
})

test('a free figure the machine could not read is left out of the header; an orphan whose process is known can be stopped', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const known = { slot: 0, pid: 777, cwd: '/tmp', command: 'pnpm e2e', ageMs: null, state: 'orphan', cpuPct: null, memKb: null }
  const status = { ...REAL_STATUS, queues: [{ ...REAL_STATUS.queues[0], holders: [known] }], machine: { ...REAL_STATUS.machine, memAvailKb: null, memTotalKb: null } }
  queueHost(on, {}, { status })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 72 } })
  const lines = textOf(await ui.find({ type: 'Box' })).split('\n')
  const at = lines.findIndex(l => l.startsWith('QUEUE'))
  expect(lines.slice(at, at + 2)).toEqual(['QUEUE · e2e 1/1 · load 1 / 8 cores', '● e2e  tmp pnpm e2e orphan [stop]'])
})

const LANE_ITEMS = [
  { content: '#12 Build the releases page', status: 'in_progress', lane: 'rd-12' },
  { content: '#13 Gallery filters', status: 'pending', lane: 'rd-13' },
  { content: '#14 Drop the old route', status: 'pending', lane: 'rd-14' },
  { content: 'Review the epic', status: 'pending' },
]
const NOW = 1_000_000
const laneEntry = (name: string, sessionId: string, startedAt: number, extra: Record<string, unknown> = {}) => ({
  pid: 1,
  id: sessionId.slice(0, 8),
  cwd: '/repo',
  kind: 'background',
  startedAt,
  sessionId,
  name,
  status: 'busy',
  state: 'working',
  ...extra,
})
const LANES = [
  laneEntry('rd-12', 'old-12', NOW - 900_000, { state: 'failed' }),
  laneEntry('rd-12', 'new-12', NOW - 125_000),
  laneEntry('rd-13', 'new-13', NOW - 30_000, { state: 'blocked', waitingFor: 'permission prompt' }),
  { pid: 2, id: 'me', cwd: '/repo', kind: 'interactive', startedAt: 0, sessionId: 's1', status: 'busy' },
]
const LANE_LIST = {
  savedAt: NOW,
  todos: {
    items: [
      { content: 'Map the routes', status: 'completed' },
      { content: 'Not needed', status: 'skipped' },
      { content: '#40 Write the loader', status: 'in_progress' },
      { content: 'Wire the table', status: 'in_progress' },
      { content: 'Third at once', status: 'in_progress' },
      { content: 'Open the PR', status: 'pending' },
      { content: 'Babysit', status: 'pending' },
    ],
  },
}

const laneStore = (): Record<string, unknown> => ({
  'todos:new-12': LANE_LIST,
  'todos:old-12': { savedAt: NOW, todos: { items: [{ content: 'Old run', status: 'in_progress' }] } },
})

function laneHost(
  on: On,
  answer: () => { exitCode: number; stdout: string } = () => ({ exitCode: 0, stdout: JSON.stringify(LANES) }),
  opts: { store?: Record<string, unknown>; panes?: Host['panes']; agents?: { id: string; type: string; description: string; status: AgentStatus }[] } = {},
) {
  const calls: string[][] = []
  quietHost(on, {}, [''], undefined, 'feat/epic\norigin/main\n0\n0\ngit@github.com:wedgey/contexory.git\n', {}, {
    store: opts.store ?? laneStore(),
    panes: opts.panes,
    claude: args => {
      calls.push([...args])
      return answer()
    },
  })
  on('agent.list', () => ({ value: opts.agents ?? [] }))
  return calls
}

const lanePane = async ($: Engine, bodyColumns = 120) => {
  const ui = await $.ui.mount({ plugin: 'session-activity', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns } })
  return { ui, lines: textOf(await ui.find({ type: 'Box' })).split('\n') }
}

test("an item with a lane shows the lane's state, and expanded, its progress and its next items; a lane no session has reads missing", async ($, on) => {
  mock.clock(on, { now: NOW })
  const calls = laneHost(on)
  await writeTodos($, { items: LANE_ITEMS })
  await openPane($)
  expect(calls).toContainEqual(['agents', '--json', '--all'])

  const { ui, lines } = await lanePane($)
  expect(await ui.find({ type: 'Text', text: '● working' })).toMatchObject({ props: { color: 'suggestion' } })
  expect(await ui.find({ type: 'Text', text: '⚠ blocked' })).toMatchObject({ props: { color: 'warning' } })
  expect(await ui.find({ type: 'Text', text: '◌ lane missing' })).toMatchObject({ props: { color: 'inactive' } })
  const at = lines.findIndex(l => l.includes('Build the releases page'))
  expect(lines.slice(at + 1, at + 5).map(l => l.trim())).toEqual([
    'lane rd-12 · working · 2m05s · 2/7',
    '◐ #40 Write the loader',
    '◐ Wire the table',
    '○ Open the PR',
  ])
  expect(lines.some(l => l.includes('lane rd-13'))).toBe(false)
  expect(lines.some(l => l.includes('Old run'))).toBe(false)

  await ui.press({ key: 'todo:#13 Gallery filters:toggle' })
  expect(await ui.find({ type: 'Text', text: 'lane rd-13 · blocked · waiting for permission prompt · 30s' })).toBeDefined()
  await ui.press({ key: 'todo:#12 Build the releases page:toggle' })
  expect(await ui.find({ type: 'Text', text: /lane rd-12/ })).toBeUndefined()
})

test('a failed or unreadable lane read keeps the last reading', async ($, on) => {
  mock.clock(on, { now: NOW })
  let answer = { exitCode: 0, stdout: JSON.stringify(LANES) }
  laneHost(on, () => answer)
  await writeTodos($, { items: LANE_ITEMS })
  await openPane($)
  for (const bad of [{ exitCode: 1, stdout: '' }, { exitCode: 0, stdout: 'Error: not logged in' }]) {
    answer = bad
    await openPane($)
    const { ui } = await lanePane($)
    expect(await ui.find({ type: 'Text', text: 'lane rd-12 · working · 2m05s · 2/7' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '⚠ blocked' })).toBeDefined()
    await ui.unmount()
  }
})

test("a lane whose list is not saved yet shows no progress figure, never 0/0", async ($, on) => {
  mock.clock(on, { now: NOW })
  laneHost(on, () => ({ exitCode: 0, stdout: JSON.stringify([laneEntry('rd-12', 'fresh', NOW - 5000)]) }))
  await writeTodos($, { items: LANE_ITEMS.slice(0, 1) })
  await openPane($)
  const { ui } = await lanePane($)
  expect(await ui.find({ type: 'Text', text: 'lane rd-12 · working · 5s' })).toBeDefined()
})

test('under 46 columns a lane item shows only its marker', async ($, on) => {
  mock.clock(on, { now: NOW })
  laneHost(on)
  await writeTodos($, { items: LANE_ITEMS })
  await openPane($)
  const { ui, lines } = await lanePane($, 40)
  expect(await ui.find({ type: 'Text', text: '●' })).toMatchObject({ props: { color: 'suggestion' } })
  expect(await ui.find({ type: 'Text', text: '⚠' })).toMatchObject({ props: { color: 'warning' } })
  expect(lines.some(l => l.includes('lane rd-12'))).toBe(false)
  expect(lines.some(l => l.includes('Write the loader'))).toBe(false)
})

test('a list with no lane never reads the agents list', async ($, on) => {
  mock.clock(on, { now: NOW })
  const calls = laneHost(on)
  await writeTodos($, { items: LANE_ITEMS.slice(3) })
  await openPane($)
  expect(calls).toEqual([])
})

test('a malformed lane list keeps that lane\'s last reading and never holds up the other lanes', async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = laneStore()
  let lanes: unknown[] = LANES
  laneHost(on, () => ({ exitCode: 0, stdout: JSON.stringify(lanes) }), { store })
  await writeTodos($, { items: LANE_ITEMS })
  await openPane($)
  store['todos:new-12'] = { savedAt: NOW, todos: { items: [null, { content: 'x', status: 'pending', ticket: 5 }] } }
  lanes = LANES.map(e => ('name' in e && e.name === 'rd-13' ? { ...e, state: 'done', waitingFor: undefined } : e))
  await openPane($)
  const { ui } = await lanePane($)
  expect(await ui.find({ type: 'Text', text: 'lane rd-12 · working · 2m05s · 2/7' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '✓ done' })).toMatchObject({ props: { color: 'success' } })
})

test('an interactive session with the lane\'s name is not the lane', async ($, on) => {
  mock.clock(on, { now: NOW })
  laneHost(on, () => ({ exitCode: 0, stdout: JSON.stringify([...LANES, { pid: 3, id: 'x', cwd: '/repo', kind: 'interactive', startedAt: NOW, sessionId: 'x-1', name: 'rd-14', status: 'idle' }]) }))
  await writeTodos($, { items: LANE_ITEMS })
  await openPane($)
  const { ui } = await lanePane($)
  expect(await ui.find({ type: 'Text', text: '◌ lane missing' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /idle/ })).toBeUndefined()
})

test('under 46 columns the lane marker is its glyph alone, so the title keeps its room beside a full right column', async ($, on) => {
  const clock = mock.clock(on, { now: NOW - 725_000 })
  let n = 0
  on('agent.spawn', () => ({ model: 'opus', agentId: `a${++n}` }))
  laneHost(on, undefined, {
    agents: [
      { id: 'a1', type: 'general-purpose', description: 'Read the loader', status: 'running' },
      { id: 'a2', type: 'general-purpose', description: 'Read the table', status: 'running' },
    ],
  })
  await writeTodos($, { items: LANE_ITEMS.slice(0, 1) })
  await spawn($, 'Read the loader', 'general-purpose')
  await spawn($, 'Read the table', 'general-purpose')
  await clock.set(NOW)
  await openPane($)
  const { ui, lines } = await lanePane($, 40)
  expect((await ui.find({ key: 'todo:#12 Build the releases page:toggle' }))?.text).toBe('Build the releases page')
  const row = lines.find(l => l.includes('Build the releases page'))!
  expect(row).toMatch(/Build the releases page ● 12m05s · 2 agents$/)
  expect(await ui.find({ type: 'Text', text: /working/ })).toBeUndefined()
  // Beside the ticket, glyphs and right column, the title keeps at least 12 of the 40 columns.
  expect(row.length - 'Build the releases page'.length).toBeLessThanOrEqual(40 - 12)
})

test("another session's names and texts are drawn with their control characters collapsed", async ($, on) => {
  mock.clock(on, { now: NOW })
  const name = 'rd\n12\u001b[2J'
  laneHost(on, () => ({ exitCode: 0, stdout: JSON.stringify([laneEntry(name, 'esc-1', NOW - 1000, { state: 'blocked', waitingFor: 'permission\nprompt\u001b[31m' })]) }), {
    store: { 'todos:esc-1': { savedAt: NOW, todos: { items: [{ content: 'Fix\nthe\u001b]0;pwned\u0007loader', status: 'in_progress' }] } } },
  })
  await writeTodos($, { items: [{ content: 'Escape test', status: 'in_progress', lane: name }] })
  await openPane($)
  const { ui, lines } = await lanePane($)
  expect(await ui.find({ type: 'Text', text: 'lane rd 12 [2J · blocked · waiting for permission prompt [31m · 1s · 0/1' })).toBeDefined()
  expect(lines.map(l => l.trim())).toContain('◐ Fix the ]0;pwned loader')
  expect(lines.some(l => /[\u0000-\u001f\u007f-\u009f]/.test(l))).toBe(false)
})

test('lanes are read every 5 s while the pane shows a lane item at work, else every 30 s; a tick inside the window skips the CLI', async ($, on) => {
  const clock = mock.clock(on, { now: 7_000_000 })
  let isShown = true
  const calls = laneHost(on, () => ({ exitCode: 0, stdout: JSON.stringify([laneEntry('rd-12', 'new-12', 6_000_000)]) }), {
    panes: () => [{ id: 'session-activity', isShown }],
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await startSession($)
  await writeTodos($, { items: LANE_ITEMS.slice(0, 1) })
  const reads = async (steps: number) => {
    const before = calls.length
    for (let i = 0; i < steps; i++) await clock.advance(5000)
    return calls.length - before
  }
  expect(await reads(1)).toBe(1)
  expect(await reads(2)).toBe(2)
  isShown = false
  expect(await reads(5)).toBe(0)
  expect(await reads(1)).toBe(1)
  isShown = true
  await writeTodos($, { items: [{ ...LANE_ITEMS[0]!, status: 'completed' }] })
  expect(await reads(5)).toBe(0)
  expect(await reads(1)).toBe(1)
})

test("a lane whose saved list is gone keeps its count while it is the same session, and drops it for a new one", async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = laneStore()
  let lanes: unknown[] = LANES
  laneHost(on, () => ({ exitCode: 0, stdout: JSON.stringify(lanes) }), { store })
  await writeTodos($, { items: LANE_ITEMS.slice(0, 1) })
  await openPane($)
  delete store['todos:new-12']
  await openPane($)
  let { ui } = await lanePane($)
  expect(await ui.find({ type: 'Text', text: 'lane rd-12 · working · 2m05s · 2/7' })).toBeDefined()
  await ui.unmount()
  lanes = [laneEntry('rd-12', 'newer-12', NOW - 1000)]
  await openPane($)
  ;({ ui } = await lanePane($))
  expect(await ui.find({ type: 'Text', text: 'lane rd-12 · working · 1s' })).toBeDefined()
})

test('lanes named like object members read as any other name', async ($, on) => {
  mock.clock(on, { now: NOW })
  laneHost(on, () => ({ exitCode: 0, stdout: JSON.stringify([laneEntry('__proto__', 'p-1', NOW - 1000), laneEntry('toString', 't-1', NOW - 1000, { state: 'valueOf' })]) }))
  await writeTodos($, {
    items: [
      { content: 'Odd one', status: 'in_progress', lane: 'constructor' },
      { content: 'Odder', status: 'in_progress', lane: '__proto__' },
      { content: 'Oddest', status: 'in_progress', lane: 'toString' },
    ],
  })
  await openPane($)
  const { ui } = await lanePane($)
  expect(await ui.find({ type: 'Text', text: '◌ lane missing' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'lane __proto__ · working · 1s' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '◌ valueOf' })).toMatchObject({ props: { color: 'inactive' } })
})
