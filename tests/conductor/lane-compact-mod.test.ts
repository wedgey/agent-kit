import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SUMMARY = { role: 'user', text: 'summary', toolUses: [] }

/** The engine beneath the mod: agent.list answers `agents`, and compact records the instructions it was given. */
function harness(on: On, agents: { id: string; type: string }[] | Error) {
  const w = { instructions: [] as (string | undefined)[] }
  on('agent.list', () => {
    if (agents instanceof Error) throw agents
    return { value: agents } as never
  })
  on('session.compact', (_$, e) => {
    w.instructions.push(e.instructions)
    return { messages: [SUMMARY] } as never
  })
  return w
}

const compact = ($: any, input: Record<string, unknown>) =>
  $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'work so far', toolUses: [] }], ...input } as never) as Promise<{ messages?: { role: string; text: string }[] }>

describe('a lane compacting in place', () => {
  test('keeps its brief and state, and resumes after the summary', async ($, on) => {
    const w = harness(on, [{ id: 'a1', type: 'conductor:lane' }])
    const r = await compact($, { agentId: 'a1' })
    expect(w.instructions[0]).toContain('every line of its lane brief whole')
    expect(r.messages?.map(m => m.text)).toEqual(['summary', expect.stringContaining('Do not report Context full')])
  })

  test('puts its own keep before any instructions already given', async ($, on) => {
    const w = harness(on, [{ id: 'a1', type: 'conductor:lane' }])
    await compact($, { agentId: 'a1', instructions: 'stress the PR' })
    expect(w.instructions[0]).toMatch(/lane brief[\s\S]*\n\nstress the PR$/)
  })

  test('leaves every other compaction alone', async ($, on) => {
    const w = harness(on, [{ id: 'a2', type: 'conductor:reviewer' }])
    for (const input of [{}, { agentId: 'a2' }, { agentId: 'unknown' }]) {
      const r = await compact($, { ...input, instructions: 'theirs' })
      expect(r.messages).toEqual([SUMMARY])
    }
    expect(w.instructions).toEqual(['theirs', 'theirs', 'theirs'])
  })

  test('falls back to the engine when the agent list fails', async ($, on) => {
    const w = harness(on, new Error('no list'))
    const r = await compact($, { agentId: 'a1' })
    expect(w.instructions).toEqual([undefined])
    expect(r.messages).toEqual([SUMMARY])
  })
})
