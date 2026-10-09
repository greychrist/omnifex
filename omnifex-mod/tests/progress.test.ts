import { expect, test } from 'claude-code/testing'

const TOOL = 'mcp__omnifex__progress'

test('the progress tool is registered with its schema up front', async ($, on) => {
  let spec: any
  on('tool.register', (_$, e) => {
    spec = e
    return { value: { tool: TOOL } }
  })
  on('session.start', (_$, e) => e)
  await $.session.start({ cwd: '/tmp' } as any)
  expect(spec.name).toBe('progress')
  expect(spec.isDeferred).toBe(false)
  expect(spec.inputSchema.required).toEqual(['done', 'total'])
})

test('a progress call is answered without running anything', async $ => {
  const ran: any = await $.tool.call({ tool: TOOL, done: 2, total: 5, note: 'Read the files' } as any)
  expect(ran.isError ?? false).toBe(false)
  expect(ran.text ?? ran.result).toContain('Progress recorded')
})

test('a progress call never asks for permission', async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))
  const verdict = await $.tool.check({ tool: TOOL, done: 1, total: 3 })
  expect(verdict.decision).toBe('allow')
})

test('every subagent is told to report progress', async ($, on) => {
  let seen = ''
  on('agent.spawn', (_$, e) => {
    seen = e.prompt
    return { model: 'test', agentId: 'a1' }
  })
  await $.agent.spawn({ prompt: 'Read the README.' })
  expect(seen.startsWith('Read the README.')).toBe(true)
  expect(seen).toContain(TOOL)
})

// agent.spawn carries no tool list, and an agent whose definition names its
// tools does not get this one — so the hint must not order a call it can't make.
test('the subagent hint is conditional on having the tool', async ($, on) => {
  let seen = ''
  on('agent.spawn', (_$, e) => {
    seen = e.prompt
    return { model: 'test', agentId: 'a1' }
  })
  await $.agent.spawn({ prompt: 'Review the diff.' })
  expect(seen).toMatch(/If you have the mcp__omnifex__progress tool/)
})

test('the main session is told when to report progress', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
  const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [], tools: [TOOL] } as any)
  const added = sections.find(s => s.id === 'omnifex:progress')
  expect(added).toBeDefined()
  expect(added!.text).toContain(TOOL)
  expect(added!.scope).toBe('session')
})

test('no instruction is added where the tool is not offered', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
  const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [], tools: ['Read'] } as any)
  expect(sections.map(s => s.id)).toEqual(['intro'])
})
