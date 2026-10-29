import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__conductor__handover'
const KEEP = 'Epic #431. Lane #569: agent a1, task t1, branch fix/569, PR open. LAND: "merge them as they pass".'
const RESUME = "Continue the epic from #431's latest hand-over comment."

/** The engine beneath the mod: compact answers per `compact`, every submit and toast is recorded. */
function harness(on: On, compact: (n: number) => { skip?: string } | Error = () => ({}), submitFails = false) {
  const w = { compacted: [] as (string | undefined)[], submitted: [] as string[], toasts: [] as string[], registered: [] as string[] }
  on('tool.register', (_$, e) => {
    w.registered.push(e.name)
    return { value: { tool: `mcp__conductor__${e.name}` } }
  })
  on('session.compact', (_$, e) => {
    w.compacted.push(e.instructions)
    const r = compact(w.compacted.length)
    if (r instanceof Error) throw r
    return (r.skip ? { skip: r.skip } : { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }) as never
  })
  on('prompt.submit', (_$, e) => {
    w.submitted.push(e.text)
    if (submitFails) throw new Error('no prompt box')
    return { text: e.text } as never
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return w
}

const handover = ($: Engine, input: Record<string, unknown>) =>
  $.tool.call({ tool: TOOL, ...input } as never) as Promise<{ result?: unknown; isError?: boolean }>
const turnEnds = ($: Engine, extra: Record<string, unknown> = {}) =>
  $.turn.complete({ turnId: 't', reason: 'answer', answer: '', durationMs: 1, isAborted: false, ...extra } as never)

describe('the handover', () => {
  test('registers its tool at session start', async ($, on) => {
    const w = harness(on)
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true } as never)
    expect(w.registered).toEqual(['handover'])
  })

  test('compacts to what the orchestrator keeps, then submits its resume prompt, once the turn ends', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on)
    const r = await handover($, { keep: KEEP, resume: RESUME })
    expect(r.isError).toBeFalsy()
    expect(w.compacted).toEqual([])
    await turnEnds($)
    await clock.advance(0)
    expect(w.compacted).toHaveLength(1)
    expect(w.compacted[0]).toContain(KEEP)
    expect(w.submitted).toEqual([RESUME])
  })

  test('runs once: a later turn end does nothing', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on)
    await handover($, { keep: KEEP, resume: RESUME })
    await turnEnds($)
    await clock.advance(0)
    await turnEnds($)
    await clock.advance(0)
    expect(w.compacted).toHaveLength(1)
    expect(w.submitted).toHaveLength(1)
  })

  test('waits for the turn to be over: retries while compact rejects', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on, n => (n < 3 ? new Error('a turn is running') : {}))
    await handover($, { keep: KEEP, resume: RESUME })
    await turnEnds($)
    await clock.advance(0)
    expect(w.submitted).toEqual([])
    await clock.advance(2_000)
    expect(w.compacted).toHaveLength(3)
    expect(w.submitted).toEqual([RESUME])
  })

  test('keeps the handover for the next turn end when a notice turn outlasts the retries', async ($, on) => {
    const clock = mock.clock(on)
    let busy = true
    const w = harness(on, () => (busy ? new Error('a turn is running') : {}))
    await handover($, { keep: KEEP, resume: RESUME })
    await turnEnds($)
    await clock.advance(60_000)
    expect(w.submitted).toEqual([])
    busy = false
    await turnEnds($)
    await clock.advance(0)
    expect(w.submitted).toEqual([RESUME])
  })

  test('shows the resume prompt when it cannot be submitted', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on, () => ({}), true)
    await handover($, { keep: KEEP, resume: RESUME })
    await turnEnds($)
    await clock.advance(0)
    expect(w.toasts.join('\n')).toContain(RESUME)
  })

  test('refuses a second call while one is under way, so it never runs twice', async ($, on) => {
    const clock = mock.clock(on)
    let busy = true
    const w = harness(on, () => (busy ? new Error('a turn is running') : {}))
    await handover($, { keep: KEEP, resume: RESUME })
    await turnEnds($)
    await clock.advance(0)
    const again = await handover($, { keep: 'other', resume: 'other' })
    expect(String(again.result)).toContain('already under way')
    await turnEnds($)
    busy = false
    await clock.advance(30_000)
    expect(w.submitted).toEqual([RESUME])
  })

  test('submits nothing when a hook skips the compaction, and says so', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on, () => ({ skip: 'vetoed' }))
    await handover($, { keep: KEEP, resume: RESUME })
    await turnEnds($)
    await clock.advance(0)
    expect(w.submitted).toEqual([])
    expect(w.toasts.join('\n')).toContain('vetoed')
  })

  for (const reason of ['aborted', 'error', 'refusal'] as const) {
    test(`is cancelled by a turn that ends ${reason}`, async ($, on) => {
      const clock = mock.clock(on)
      const w = harness(on)
      await handover($, { keep: KEEP, resume: RESUME })
      await turnEnds($, { reason, isAborted: reason === 'aborted' })
      await clock.advance(5_000)
      expect(w.compacted).toEqual([])
      expect(w.submitted).toEqual([])
    })
  }

  test("ignores a subagent's turn end and waits for the main loop's", async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on)
    await handover($, { keep: KEEP, resume: RESUME })
    await turnEnds($, { agentId: 'lane-1' })
    await clock.advance(0)
    expect(w.compacted).toEqual([])
    await turnEnds($)
    await clock.advance(0)
    expect(w.submitted).toEqual([RESUME])
  })

  test('refuses a delegate, so a lane cannot compact the orchestrator', async ($, on) => {
    const clock = mock.clock(on)
    const w = harness(on)
    const r = await handover($, { keep: KEEP, resume: RESUME, agentId: 'lane-1' })
    expect(r.isError).toBe(true)
    await turnEnds($)
    await clock.advance(0)
    expect(w.compacted).toEqual([])
  })

  test('refuses a call missing keep or resume', async ($, on) => {
    harness(on)
    expect((await handover($, { keep: KEEP })).isError).toBe(true)
    expect((await handover($, { keep: ' ', resume: RESUME })).isError).toBe(true)
  })
})
