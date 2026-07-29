import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { filterDisplayableMessages } from '../messageFilters';

const userImage = (): JsonlNode =>
  ({
    kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '',
    raw: {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
          },
        ],
      },
    },
  }) as unknown as JsonlNode;

const userTextAndImage = (): JsonlNode =>
  ({
    kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '',
    raw: {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
          },
        ],
      },
    },
  }) as unknown as JsonlNode;

const userText = (text: string): JsonlNode =>
  ({ kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '', raw: { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } } }) as unknown as JsonlNode;

describe('filterDisplayableMessages', () => {
  it('keeps user messages with text only', () => {
    const out = filterDisplayableMessages([userText('hello')]);
    expect(out).toHaveLength(1);
  });

  it('keeps user messages with text + image', () => {
    const out = filterDisplayableMessages([userTextAndImage()]);
    expect(out).toHaveLength(1);
  });

  it('keeps user messages that contain only an image', () => {
    const out = filterDisplayableMessages([userImage()]);
    expect(out).toHaveLength(1);
  });

  describe('hook lifecycle filtering', () => {
    // The CLI's `system+hook_*` family is plumbing noise — `hook_started`,
    // `hook_response`, and `hook_progress` (mid-hook stdout/stderr) all
    // describe internal hook execution and should never appear in the
    // chat timeline by default. The set guarding `dropHookLifecycle`
    // historically only listed `hook_started` and `hook_response`,
    // letting `hook_progress` leak in as `system.unknown` gray strips.
    const sysHook = (subtype: string): JsonlNode =>
      ({ kind: 'system', subtype, sessionId: '', receivedAt: '', raw: { type: 'system', subtype } }) as unknown as JsonlNode;

    it('drops hook_started when dropHookLifecycle is on (default)', () => {
      const out = filterDisplayableMessages([sysHook('hook_started')]);
      expect(out).toHaveLength(0);
    });

    it('drops hook_response when dropHookLifecycle is on (default)', () => {
      const out = filterDisplayableMessages([sysHook('hook_response')]);
      expect(out).toHaveLength(0);
    });

    it('drops hook_progress when dropHookLifecycle is on (default)', () => {
      // Regression: hook_progress was missing from HOOK_LIFECYCLE_SUBTYPES
      // and leaked into messages[] as system.unknown noise — exactly the
      // same plumbing-noise category as hook_started / hook_response.
      const out = filterDisplayableMessages([sysHook('hook_progress')]);
      expect(out).toHaveLength(0);
    });

    it('keeps hook_progress when hideHookLifecycle is explicitly off', () => {
      const out = filterDisplayableMessages([sysHook('hook_progress')], {
        hidePartialStreaming: false,
        hideSubagentLifecycle: false,
        hideHookLifecycle: false,
        hideRateLimitNotices: false,
      });
      expect(out).toHaveLength(1);
    });
  });

  describe('system:status transient pings', () => {
    const sysStatus = (status: string): JsonlNode =>
      ({ kind: 'system', subtype: 'status', sessionId: '', receivedAt: '', raw: { type: 'system', subtype: 'status', status } }) as unknown as JsonlNode;

    it('drops system:status — it is surfaced as the live activity label, never a transcript row', () => {
      // These are transient per-turn phase pings (requesting / compacting).
      // The reducer turns them into the live "Running…" activity label; they
      // must never render as an empty side-line in the conversation history.
      const out = filterDisplayableMessages([sysStatus('requesting')]);
      expect(out).toHaveLength(0);
    });
  });

  describe('skill-injection isMeta exemption', () => {
    // The Claude Code CLI persists skill-body injections with isMeta:true,
    // which the CLI live-stream version emits as isSynthetic:true (no isMeta).
    // The filter must keep skill bodies visible even when isMeta is set —
    // otherwise the `Skill: <name>` card disappears after the renderer
    // reloads the session from JSONL.

    const skillToolUse = (id: string, skillName: string): JsonlNode =>
      ({
        kind: 'assistant', sessionId: '', receivedAt: '',
        raw: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: skillName } }] },
        },
      }) as unknown as JsonlNode;

    const skillToolResult = (toolUseId: string, body = 'Launching skill: x'): JsonlNode =>
      ({
        kind: 'user', userKind: 'tool-result', sessionId: '', receivedAt: '',
        raw: {
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: body }] },
        },
      }) as unknown as JsonlNode;

    const skillBody = (text: string, isMeta = true): JsonlNode =>
      ({
        kind: 'user', userKind: 'meta-other', sessionId: '', receivedAt: '',
        raw: {
          type: 'user',
          isMeta,
          message: { role: 'user', content: [{ type: 'text', text }] },
        },
      }) as unknown as JsonlNode;

    it('keeps an isMeta user message that is a skill injection', () => {
      const messages = [
        skillToolUse('toolu_x', 'merge-to-main'),
        skillToolResult('toolu_x'),
        skillBody('# Merge to Main\n\nRun the gate.', true),
      ];
      const out = filterDisplayableMessages(messages);
      expect(out).toHaveLength(3);
      // The skill body must be the last one
      const last = out[out.length - 1] as unknown as { raw: { isMeta: boolean; message: { content: { text: string }[] } } };
      expect(last.raw.isMeta).toBe(true);
      expect(last.raw.message.content[0].text).toContain('# Merge to Main');
    });

    it('still drops an isMeta user message that is NOT a skill injection (e.g. plain meta noise)', () => {
      const messages = [
        skillBody('orphan meta with no preceding Skill tool', true),
      ];
      const out = filterDisplayableMessages(messages);
      expect(out).toHaveLength(0);
    });

    it('keeps a non-isMeta user message regardless of skill detection', () => {
      // Backstop: this is the live-stream shape (isSynthetic only). Already
      // passes today; lock it in so no future regression drops live skill
      // bodies before they hit the renderer.
      const messages = [
        skillToolUse('toolu_y', 'foo'),
        skillToolResult('toolu_y'),
        skillBody('# foo body', false),
      ];
      const out = filterDisplayableMessages(messages);
      expect(out).toHaveLength(3);
    });
  });

});

describe('unknown content-block visibility', () => {
  it('keeps a user message whose only block is an unrecognized type', () => {
    // The renderer has a catch-all card for unknown blocks; dropping the
    // whole message here would silently erase it one stage earlier.
    const node = {
      kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '',
      raw: {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'document', source: { type: 'url', url: 'https://x.test/a.pdf' } }],
        },
      },
    } as unknown as JsonlNode;
    const out = filterDisplayableMessages([node]);
    expect(out).toHaveLength(1);
  });
});

describe('forwarded subagent assistant text (--forward-subagent-text)', () => {
  const parentTaskDispatch = (): JsonlNode =>
    ({
      kind: 'assistant', sessionId: '', receivedAt: '',
      raw: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_fwd_1', name: 'Task', input: { description: 'sub', prompt: 'go' } },
          ],
        },
      },
    }) as unknown as JsonlNode;

  const forwardedAssistant = (): JsonlNode =>
    ({
      kind: 'assistant', sessionId: '', receivedAt: '',
      raw: {
        type: 'assistant',
        parent_tool_use_id: 'toolu_fwd_1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'subagent says hi' }] },
      },
    }) as unknown as JsonlNode;

  const mainAssistant = (): JsonlNode =>
    ({
      kind: 'assistant', sessionId: '', receivedAt: '',
      raw: {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'parent says hi' }] },
      },
    }) as unknown as JsonlNode;

  it('hides forwarded subagent assistant messages from the transcript', () => {
    // Their content belongs to the SubagentBar row, not the main transcript —
    // interleaving subagent narration with the parent conversation is noise.
    const msgs = [parentTaskDispatch(), forwardedAssistant(), mainAssistant()];
    const out = filterDisplayableMessages(msgs);
    const texts = out.map((m) =>
      JSON.stringify(
        (m as unknown as { raw?: { message?: { content?: unknown } } }).raw?.message?.content ?? '',
      ),
    );
    expect(texts.join()).not.toContain('subagent says hi');
    expect(texts.join()).toContain('parent says hi');
  });

  it('keeps main-chain assistants with a null parent_tool_use_id', () => {
    const out = filterDisplayableMessages([mainAssistant()]);
    expect(out).toHaveLength(1);
  });

  // Tool results for widget-backed tools are normally dropped, because the
  // widget is assumed to render the payload. That assumption breaks for
  // images: no widget renders them (MCPWidget discards `result` outright), so
  // dropping the message loses the screenshot entirely.
  describe('tool results carrying images', () => {
    const toolCall = (id: string, name: string): JsonlNode =>
      ({
        kind: 'assistant', sessionId: '', receivedAt: '',
        raw: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
        },
      }) as unknown as JsonlNode;

    const imageResult = (toolUseId: string): JsonlNode =>
      ({
        kind: 'user', userKind: 'tool-result', sessionId: '', receivedAt: '',
        raw: {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: [
                  { type: 'text', text: 'Screenshot captured' },
                  {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
                  },
                ],
              },
            ],
          },
        },
      }) as unknown as JsonlNode;

    const textResult = (toolUseId: string): JsonlNode =>
      ({
        kind: 'user', userKind: 'tool-result', sessionId: '', receivedAt: '',
        raw: {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: 'ok' }] },
            ],
          },
        },
      }) as unknown as JsonlNode;

    it('keeps an MCP tool result that contains a screenshot', () => {
      const out = filterDisplayableMessages([
        toolCall('t1', 'mcp__chrome-devtools__take_screenshot'),
        imageResult('t1'),
      ]);
      expect(out).toHaveLength(2);
    });

    it('keeps a Read result that contains an image', () => {
      const out = filterDisplayableMessages([toolCall('t2', 'Read'), imageResult('t2')]);
      expect(out).toHaveLength(2);
    });

    // The existing suppression must survive — only image-bearing results are
    // rescued, or every widget tool starts double-rendering its payload.
    it('still drops a widget-backed tool result with no images', () => {
      const out = filterDisplayableMessages([
        toolCall('t3', 'mcp__chrome-devtools__list_pages'),
        textResult('t3'),
      ]);
      expect(out).toHaveLength(1);
    });
  });
});
