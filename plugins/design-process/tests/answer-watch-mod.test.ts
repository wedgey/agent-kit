import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__design-process__answer_watch'
const SLUG = 'slug-1'
const HOUR = 3_600_000

type Row = Record<string, unknown>
/** The artifact beneath the mod: `db` maps a collection or document path to its rows, `fail` makes every call error. */
function harness(on: On, entries: Record<string, unknown> = {}) {
  const w = { db: {} as Record<string, Row[]>, round: {} as Record<string, Row>, registered: [] as string[], submitted: [] as string[], toasts: [] as string[], statuses: [] as unknown[], calls: 0, fail: false, submitFails: false, limits: [] as unknown[], gate: null as null | Promise<void>, inSubmit: false }
  mock.store(on, entries)
  on('session.id', () => ({ value: 's-me' }))
  on('mcp.call', (_$, e) => {
    w.calls++
    if (w.fail) throw new Error('mcp down')
    const a = e.args as { collection?: string; path?: string; limit?: number }
    if (e.tool === 'db_list') w.limits.push(a.limit)
    const text = e.tool === 'db_list'
      ? [JSON.stringify({ count: 1 }), '<untrusted-document-x>', ...(w.db[a.collection!] ?? []).map(r => JSON.stringify({ id: r.id, data: r.data, version: 1 })), '</untrusted-document-x>'].join('\n')
      : w.round[a.path!] ? [JSON.stringify({ exists: true }), JSON.stringify(w.round[a.path!])].join('\n') : JSON.stringify({ exists: false })
    return { value: { content: [{ type: 'text', text }], isError: false } } as never
  })
  on('prompt.submit', async (_$, e) => {
    w.inSubmit = true
    if (w.gate) await w.gate
    if (w.submitFails) throw new Error('no prompt box')
    w.submitted.push(e.text)
    return { text: e.text } as never
  })
  on('ui.toast', (_$, e) => (w.toasts.push(String(e.text)), { value: undefined }))
  on('ui.status', (_$, e) => (w.statuses.push(e.text), { value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('tool.register', (_$, e) => (w.registered.push(e.name), { value: { tool: `mcp__design-process__${e.name}` } }))
  on('turn.complete', () => ({ text: '' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return w
}

const watch = ($: Engine, input: Record<string, unknown> = {}) =>
  $.tool.call({ tool: TOOL, slug: SLUG, round: 'r1', screens: [1], ...input } as never) as Promise<{ result?: unknown; isError?: boolean }>
const answer = (id: string, data: Row) => ({ id, data })

describe('the answer watch', () => {
  test('registers its tool at session start', async ($, on) => {
    const w = harness(on)
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)
    expect(w.registered).toEqual(['answer_watch'])
    expect(w.calls).toBe(0)
  })

  test('arming stores the watch, shows it, and polls every 10 s', async ($, on) => {
    const clock = mock.clock(on, { now: 1000 })
    const w = harness(on)
    const r = await watch($)
    expect(r.isError).toBeFalsy()
    expect(w.statuses.at(-1)).toContain('r1')
    expect(w.calls).toBe(0)
    await clock.advance(10_000)
    expect(w.calls).toBe(3)
    await clock.advance(10_000)
    expect(w.calls).toBe(6)
    expect(w.submitted).toEqual([])
  })

  test('a count of screens watches threads 1 to N, not 0 or N+1', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on)
    w.db['rounds/r1/threads/2/msgs'] = [answer('m1', { from: 'owner', text: 'hi', sentAt: 1 })]
    w.db['rounds/r1/threads/0/msgs'] = [answer('m0', { from: 'owner', text: 'hi', sentAt: 1 })]
    w.db['rounds/r1/threads/3/msgs'] = [answer('m3', { from: 'owner', text: 'hi', sentAt: 1 })]
    await watch($, { screens: 2 })
    await clock.advance(10_000)
    expect(w.submitted[0]).toContain('rounds/r1/threads/2/msgs/m1')
    expect(w.submitted[0]).not.toContain('threads/0')
    expect(w.submitted[0]).not.toContain('threads/3')
  })

  test('lists with a limit of 1000', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on)
    await watch($)
    await clock.advance(10_000)
    expect(w.limits.length).toBeGreaterThan(0)
    expect(w.limits.every(l => l === 1000)).toBe(true)
  })

  test('arming the same round again keeps what was seen', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on)
    await watch($)
    w.db['rounds/r1/answers'] = [answer('u1', { sentAt: 1 })]
    await clock.advance(10_000)
    await watch($)
    await clock.advance(20_000)
    expect(w.submitted).toHaveLength(1)
  })

  test('a stop during an in-flight submit is not undone when the submit fails', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on)
    let release!: () => void
    w.gate = new Promise<void>(r => (release = r))
    w.submitFails = true
    await watch($)
    w.db['rounds/r1/answers'] = [answer('u1', { sentAt: 1 })]
    const tick = clock.advance(10_000)
    for (let i = 0; i < 200 && !w.inSubmit; i++) await new Promise(r => setTimeout(r, 5))
    expect(w.inSubmit).toBe(true)
    await watch($, { stop: true })
    release()
    await tick
    await clock.advance(10_000)
    const calls = w.calls
    await clock.advance(30_000)
    expect(w.calls).toBe(calls)
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)
    await clock.advance(30_000)
    expect(w.calls).toBe(calls)
  })

  test('refuses a call without a slug and round', async ($, on) => {
    harness(on)
    expect((await watch($, { round: '' })).isError).toBe(true)
  })

  test('an owner answer wakes once, naming the slug, round and path, and not on the next tick', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on)
    await watch($)
    w.db['rounds/r1/answers'] = [answer('u1', { picks: { a: 1 }, note: 'x', sentAt: 5 })]
    await clock.advance(10_000)
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]).toContain(SLUG)
    expect(w.submitted[0]).toContain('round r1')
    expect(w.submitted[0]).toContain('rounds/r1/answers/u1')
    await clock.advance(30_000)
    expect(w.submitted).toHaveLength(1)
  })

  test('a changed sentAt on the same row wakes again', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on)
    await watch($)
    w.db['rounds/r1/answers'] = [answer('u1', { sentAt: 5 })]
    await clock.advance(10_000)
    w.db['rounds/r1/answers'] = [answer('u1', { sentAt: 6 })]
    await clock.advance(10_000)
    expect(w.submitted).toHaveLength(2)
  })

  test('does not wake twice after a reload: the store holds what was seen', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on, {
      'answer-watch:s-me': { slug: SLUG, round: 'r1', screens: [1], armedAt: 0, seen: { 'rounds/r1/answers/u1': '5' } },
    })
    w.db['rounds/r1/answers'] = [answer('u1', { sentAt: 5 })]
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)
    await clock.advance(30_000)
    expect(w.calls).toBeGreaterThan(0)
    expect(w.submitted).toEqual([])
    w.db['rounds/r1/answers'].push(answer('u2', { sentAt: 7 }))
    await clock.advance(10_000)
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]).toContain('answers/u2')
    expect(w.submitted[0]).not.toContain('answers/u1')
  })

  test('never takes over a watch another session armed', async ($, on) => {
    const clock = mock.clock(on)
    const armed = { slug: SLUG, round: 'r1', screens: [1], armedAt: 0, seen: {} }
    const w = harness(on, { 'answer-watch:s-other': armed, 'answer-watch': armed })
    w.db['rounds/r1/answers'] = [answer('u1', { sentAt: 5 })]
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)
    await $.turn.complete({} as never)
    await clock.advance(60_000)
    expect(w.calls).toBe(0)
    expect(w.submitted).toEqual([])
  })

  test('a claude row never wakes', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on)
    await watch($)
    w.db['rounds/r1/threads/1/msgs'] = [answer('m1', { from: 'claude', text: 'done', sentAt: 5 })]
    await clock.advance(30_000)
    expect(w.submitted).toEqual([])
  })

  test('an owner chat row wakes, and a redraw row says so', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on)
    await watch($)
    w.db['rounds/r1/threads/1/msgs'] = [answer('m1', { from: 'owner', kind: 'redraw', text: 'again', sentAt: 5 })]
    await clock.advance(10_000)
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]).toContain('rounds/r1/threads/1/msgs/m1 (redraw)')
  })

  test('rows arriving together wake once', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on)
    await watch($)
    w.db['rounds/r1/answers'] = [answer('u1', { sentAt: 1 })]
    w.db['rounds/r1/threads/1/msgs'] = [answer('m1', { from: 'owner', text: 'q', sentAt: 2 })]
    await clock.advance(10_000)
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]).toContain('answers/u1')
    expect(w.submitted[0]).toContain('threads/1/msgs/m1')
  })

  test('offers the rows again when the wake could not be submitted', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on)
    await watch($)
    w.db['rounds/r1/answers'] = [answer('u1', { sentAt: 1 })]
    w.submitFails = true
    await clock.advance(10_000)
    w.submitFails = false
    await clock.advance(10_000)
    expect(w.submitted).toHaveLength(1)
  })

  test('stops polling once the round is handled', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on)
    await watch($)
    w.round['rounds/r1'] = { status: 'handled', handledAt: 9 }
    w.db['rounds/r1/answers'] = [answer('u1', { sentAt: 1 })]
    await clock.advance(10_000)
    expect(w.submitted).toEqual([])
    expect(w.statuses.at(-1)).toBeUndefined()
    expect(w.toasts.join()).toContain('handled')
    expect(w.submitted).toEqual([])
    const calls = w.calls
    await clock.advance(60_000)
    expect(w.calls).toBe(calls)
  })

  test('stops after 6 hours', async ($, on) => {
    const clock = mock.clock(on, { now: 7 * HOUR })
    const w = harness(on, { 'answer-watch:s-me': { slug: SLUG, round: 'r1', screens: [], armedAt: 0, seen: {} } })
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)
    await clock.advance(10_000)
    expect(w.toasts.join()).toContain('6 hours')
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]).toContain('stopped: 6 hours passed')
    expect(w.submitted[0]).toContain('r1')
    const calls = w.calls
    await clock.advance(HOUR)
    expect(w.calls).toBe(calls)
  })

  test('stops when told to, and forgets the watch', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on)
    await watch($)
    await watch($, { stop: true })
    expect(w.statuses.at(-1)).toBeUndefined()
    expect(w.submitted).toEqual([])
    await clock.advance(60_000)
    expect(w.calls).toBe(0)
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)
    await clock.advance(60_000)
    expect(w.calls).toBe(0)
  })

  test('MCP errors never throw, are retried, and 90 in a row stop the watch and tell the session', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on)
    await watch($)
    w.fail = true
    await clock.advance(10_000 * 89)
    expect(w.toasts).toEqual([])
    w.fail = false
    await clock.advance(10_000)
    w.fail = true
    await clock.advance(10_000 * 90)
    expect(w.toasts.join()).toContain('90 failed checks')
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]).toContain('90 failed checks in a row')
    const calls = w.calls
    await clock.advance(60_000)
    expect(w.calls).toBe(calls)
  })

  test('arming a new round replaces the old watch', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on)
    await watch($)
    await watch($, { round: 'r2' })
    w.db['rounds/r1/answers'] = [answer('u1', { sentAt: 1 })]
    w.db['rounds/r2/answers'] = [answer('u2', { sentAt: 1 })]
    await clock.advance(10_000)
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]).toContain('round r2')
    expect(w.submitted[0]).not.toContain('answers/u1')
  })

  test('stopping an old round does not stop the new one', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on)
    await watch($)
    await watch($, { round: 'r2' })
    await watch($, { stop: true })
    w.db['rounds/r2/answers'] = [answer('u2', { sentAt: 1 })]
    await clock.advance(10_000)
    expect(w.submitted).toHaveLength(1)
  })
})
