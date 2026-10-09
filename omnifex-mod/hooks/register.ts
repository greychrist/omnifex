import type { Register } from 'claude-code'

// OmniFex's bundled mod. OmniFex loads it into every Claude session it starts
// (`--plugin-dir`), and it does one job: give the model a way to say how far
// through its work it is. Nothing in the CLI reports that on its own, and the
// task tools that used to are switched off on current models and were never
// offered to subagents.
//
// The tool's answer is a no-op. OmniFex reads the *call* — it lands in the
// session's stream and in each subagent's transcript like any tool_use — so
// the mod needs no channel back to the app.
//
// Rule for every hook here: never break a session. Each one passes the event
// on, and a failure falls through to what the engine would have done anyway.

const TOOL_NAME = 'progress'
const TOOL = 'mcp__omnifex__progress'

const DESCRIPTION =
  'Report how far through your task you are, so the person can see it. ' +
  'Call it once you know the steps (done: 0), then after each step. ' +
  '`total` is your best estimate of the steps the whole task needs; revise it if the plan changes.'

const SUBAGENT_HINT =
  `\n\nReport your progress with the ${TOOL} tool: call it with done: 0 and your ` +
  'estimated total once you know the steps, then after each step with a short note.'

const MAIN_HINT =
  `# Progress\nWhen a request needs three or more distinct steps, report progress with the ${TOOL} ` +
  'tool: once you know the steps (done: 0, total: your estimate), then after each step with a short note. ' +
  'Skip it for quick answers and single edits.'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL_NAME,
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'number', description: 'Steps finished so far' },
          total: { type: 'number', description: 'Estimated steps in the whole task' },
          note: { type: 'string', description: 'What you just finished, in a few words' },
        },
        required: ['done', 'total'],
      },
      isDeferred: false,
    })
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('tool.call', { tool: TOOL }, async () => ({ result: 'Progress recorded.' }))
    .catch(() => ({ result: 'Progress recorded.' }))

  on('tool.check', { tool: TOOL }, async () => ({ decision: 'allow' }))

  on('agent.spawn', async ($, e, next) => next({ ...e, prompt: e.prompt + SUBAGENT_HINT }))
    .catch(($, e, next) => (next.called ? undefined : next(e)))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(TOOL)) return composed
    return {
      sections: [...composed.sections, { id: 'omnifex:progress', text: MAIN_HINT, scope: 'session' }],
    }
  })
}
