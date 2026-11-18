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

describe('a drafter or fixer compacting in place', () => {
  test('keeps its generator ranges and board verdicts, and resumes after the summary', async ($, on) => {
    const w = harness(on, [{ id: 'a1', type: 'design-process:drafter' }])
    const r = await compact($, { agentId: 'a1' })
    expect(w.instructions[0]).toContain('every board image it has looked at, with its verdict')
    expect(r.messages?.map(m => m.text)).toEqual(['summary', expect.stringContaining('Do not read your generator whole')])
  })

  test('puts its own keep before any instructions already given', async ($, on) => {
    const w = harness(on, [{ id: 'a1', type: 'design-process:drafter' }])
    await compact($, { agentId: 'a1', instructions: 'stress the PR' })
    expect(w.instructions[0]).toMatch(/Drop file contents, image contents and tool output.\n\nstress the PR$/)
  })

  test('keeps the same for a fixer', async ($, on) => {
    const w = harness(on, [{ id: 'f1', type: 'design-process:fixer' }])
    const r = await compact($, { agentId: 'f1' })
    expect(w.instructions[0]).toContain('each fix pass')
    expect(r.messages?.at(-1)?.text).toContain('compacted in place')
  })

  test('leaves every other compaction alone', async ($, on) => {
    const w = harness(on, [{ id: 'a2', type: 'design-process:reviewer' }])
    for (const input of [{}, { agentId: 'a2' }, { agentId: 'unknown' }]) {
      const r = await compact($, { ...input, instructions: 'theirs' })
      expect(r.messages).toEqual([SUMMARY])
    }
    expect(w.instructions).toEqual(['theirs', 'theirs', 'theirs'])
  })

  test('leaves a reviewer alone while a drafter is running', async ($, on) => {
    const w = harness(on, [{ id: 'a1', type: 'design-process:drafter' }, { id: 'a2', type: 'design-process:reviewer' }])
    const r = await compact($, { agentId: 'a2', instructions: 'theirs' })
    expect(w.instructions).toEqual(['theirs'])
    expect(r.messages).toEqual([SUMMARY])
  })

  test('adds the resume note once when the engine hands back a summary that already has it', async ($, on) => {
    on('agent.list', () => ({ value: [{ id: 'a1', type: 'design-process:drafter' }] }) as never)
    let kept: { role: string; text: string; toolUses: never[] }[] | undefined
    on('session.compact', () => ({ messages: kept ?? [SUMMARY] }) as never)
    const first = await compact($, { agentId: 'a1', trigger: 'precompute' })
    kept = first.messages as never
    const second = await compact($, { agentId: 'a1' })
    expect(second.messages?.map(m => m.text)).toEqual(['summary', expect.stringContaining('compacted in place')])
  })

  test('falls back to the engine when the agent list fails', async ($, on) => {
    const w = harness(on, new Error('no list'))
    const r = await compact($, { agentId: 'a1' })
    expect(w.instructions).toEqual([undefined])
    expect(r.messages).toEqual([SUMMARY])
  })
})
