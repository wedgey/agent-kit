import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const CWD = '/w/lane'

type Verdict = 'allow' | 'ask' | 'deny' | 'missing'

/**
 * The engine beneath the mod. `decide` stands for decide.mjs's stdout, or throws as a failed spawn.
 * `verdict` is the engine's permission decision for the queued form under the session's mode:
 * `allow` under bypassPermissions (or a rule allowing it), `ask` under default, acceptEdits and
 * auto, `deny` under dontAsk; `missing` stands for an engine with no `$.tool.check`.
 */
function harness(on: On, decide: () => string = () => '', env: Record<string, string> = {}, verdict: Verdict = 'allow') {
  const w = { ran: [] as string[], checked: [] as unknown[], helper: [] as { argv: string[]; stdin?: string; cwd?: string }[] }
  mock.env(on, env)
  on('tool.check', (_$, e) => {
    if (e.tool_use_id !== undefined) return { decision: 'allow' as const }
    w.checked.push(e.input)
    if (verdict === 'missing') throw new Error('no implementation for tool.check')
    return { decision: verdict }
  })
  on('session.cwd', () => ({ value: CWD }))
  on('ui.log', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    w.helper.push({ argv: [...e.argv], stdin: e.init?.stdin, cwd: e.init?.cwd })
    return { value: { exitCode: 0, stdout: decide(), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash') w.ran.push(e.command)
    return { result: { stdout: 'ok', stderr: '' } as never, text: 'ok' }
  })
  return w
}

type Outcome = { deny?: string }
const bash = async ($: Engine, command: string, background = false) =>
  (await $.tool.call({ tool: 'Bash', command, ...(background ? { run_in_background: true } : {}) })) as Outcome

const QUEUED = "node '/p/skills/conductor/tools/queue.mjs' run --queue=tests -- bash -c 'pytest'"
const SUGGEST = `"pytest" is a heavy command and every repo on this box shares one queue. Run the whole command as: ${QUEUED}\nRun it in the background and wait for the completion notice.`
const QUEUED_OUT = JSON.stringify({ command: QUEUED, suggest: SUGGEST })

describe('the Bash gate', () => {
  test('passes a light command without starting Node', async ($, on) => {
    const w = harness(on)
    await bash($, 'git status')
    expect(w.ran).toEqual(['git status'])
    expect(w.helper).toEqual([])
  })

  test('denies a foreground wait loop without starting Node', async ($, on) => {
    const w = harness(on)
    const r = await bash($, 'until true; do sleep 1; done')
    expect(r.deny).toMatch(/^Do not block the turn by sleeping or polling\./)
    expect(w.ran).toEqual([])
    expect(w.helper).toEqual([])
  })

  test('passes everything when bypassed, wait loops included', async ($, on) => {
    const w = harness(on, () => '', { CONDUCTOR_HOOKS: 'off' })
    await bash($, 'pytest')
    await bash($, 'until true; do sleep 1; done')
    expect(w.ran).toEqual(['pytest', 'until true; do sleep 1; done'])
    expect(w.helper).toEqual([])
  })

  test('passes everything in CI', async ($, on) => {
    const w = harness(on, () => '', { CI: '1' })
    await bash($, 'pytest')
    expect(w.ran).toEqual(['pytest'])
  })

  test('under bypassPermissions (the engine answers allow) rewrites a background heavy command in place, asking decide.mjs with the call and the cwd', async ($, on) => {
    const w = harness(on, () => QUEUED_OUT)
    await bash($, 'pytest', true)
    expect(w.ran).toEqual([QUEUED])
    expect(w.helper).toHaveLength(1)
    expect(w.helper[0]?.argv[0]).toBe('node')
    expect(w.helper[0]?.argv[1]).toMatch(/\/skills\/conductor\/tools\/hooks\/decide\.mjs$/)
    expect(w.helper[0]?.cwd).toBe(CWD)
    expect(JSON.parse(w.helper[0]?.stdin ?? '{}')).toEqual({
      tool_name: 'Bash',
      tool_input: { command: 'pytest', run_in_background: true },
      cwd: CWD,
    })
  })

  test('under bypassPermissions rewrites a foreground heavy command in place when decide.mjs found a free slot', async ($, on) => {
    const w = harness(on, () => QUEUED_OUT)
    await bash($, 'pytest')
    expect(w.ran).toEqual([QUEUED])
    expect(JSON.parse(w.helper[0]?.stdin ?? '{}').tool_input.run_in_background).toBe(false)
  })

  test('denies a foreground heavy command on a full queue', async ($, on) => {
    const reason = 'The "tests" queue is full (held by lane-a (5s); 0 waiting). Rerun the same command with run_in_background: true'
    const w = harness(on, () => JSON.stringify({ deny: reason }))
    const r = await bash($, 'pytest')
    expect(r.deny).toBe(reason)
    expect(w.ran).toEqual([])
  })

  test('denies a duplicate with the message queue.mjs wrote', async ($, on) => {
    const reason = '[queue] not starting it twice: "pytest" is already running in slot 0 of the tests queue (1m30s), from /w/lane.'
    const w = harness(on, () => JSON.stringify({ deny: reason }))
    const r = await bash($, 'pytest', true)
    expect(r.deny).toBe(reason)
    expect(w.ran).toEqual([])
  })

  test('passes the command as it was when decide.mjs says nothing, as in a managed repo', async ($, on) => {
    const w = harness(on, () => '')
    await bash($, 'pytest')
    expect(w.ran).toEqual(['pytest'])
    expect(w.helper).toHaveLength(1)
  })

  test('asks the engine about the queued form, not the command as typed', async ($, on) => {
    const w = harness(on, () => QUEUED_OUT)
    await bash($, 'pytest', true)
    expect(w.checked).toEqual([{ command: QUEUED }])
  })

  for (const [mode, verdict] of [
    ['default', 'ask'],
    ['acceptEdits', 'ask'],
    ['auto', 'ask'],
    ['dontAsk', 'deny'],
  ] as const) {
    test(`under ${mode} (the engine answers ${verdict}) denies with the queued form to run in the background`, async ($, on) => {
      const w = harness(on, () => QUEUED_OUT, {}, verdict)
      for (const background of [true, false]) {
        const r = await bash($, 'pytest', background)
        expect(r.deny).toBe(SUGGEST)
      }
      expect(w.ran).toEqual([])
    })
  }

  test('denies with the queued form when the engine has no permission check to ask', async ($, on) => {
    const w = harness(on, () => QUEUED_OUT, {}, 'missing')
    const r = await bash($, 'pytest', true)
    expect(r.deny).toBe(SUGGEST)
    expect(w.ran).toEqual([])
  })

  test('denies a duplicate and a full queue the same whatever the mode', async ($, on) => {
    const reason = '[queue] not starting it twice: "pytest" is already running in slot 0 of the tests queue (5s), from /w/lane.'
    const w = harness(on, () => JSON.stringify({ deny: reason }), {}, 'ask')
    expect((await bash($, 'pytest', true)).deny).toBe(reason)
    expect(w.checked).toEqual([])
  })

  test('runs the command as it was when decide.mjs cannot run', async ($, on) => {
    const w = harness(on, () => {
      throw new Error('spawn node ENOENT')
    })
    await bash($, 'pytest')
    expect(w.ran).toEqual(['pytest'])
  })
})
