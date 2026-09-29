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

  describe('queue-operation task-notification carriers', () => {
    const XML = '<task-notification>\n<task-id>brh39815u</task-id>\n<tool-use-id>toolu_019Bf8</tool-use-id>\n<status>completed</status>\n</task-notification>';
    const queueOp = (operation: string, content?: string): JsonlNode =>
      ({
        kind: 'queue-operation', sessionId: '', receivedAt: '2026-08-19T15:47:21.000Z',
        raw: { type: 'queue-operation', operation, ...(content === undefined ? {} : { content }) },
      }) as unknown as JsonlNode;

    it('drops the enqueue carrier — its XML is consumed by the SubagentBar', () => {
      expect(filterDisplayableMessages([queueOp('enqueue', XML)])).toHaveLength(0);
    });

    it('drops the matching remove carrier', () => {
      expect(filterDisplayableMessages([queueOp('remove', XML)])).toHaveLength(0);
    });

    it('keeps a queued user prompt — that enqueue is the user\'s own message, not bookkeeping', () => {
      expect(filterDisplayableMessages([queueOp('enqueue', 'Reply with exactly: ok')])).toHaveLength(1);
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

    const skillBody = (text: string, isMeta = true, sourceToolUseID = 'toolu_x'): JsonlNode =>
      ({
        kind: 'user', userKind: 'meta-other', sessionId: '', receivedAt: '',
        raw: {
          type: 'user',
          isMeta,
          // The CLI names the originating Skill call on every companion
          // record. Detection keys on this rather than on the record's
          // position, so a re-invocation preamble can't displace the body.
          sourceToolUseID,
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
      // Backstop: the meta-noise filter is the only thing that drops user
      // rows here, so anything without isMeta survives whatever skill
      // detection concludes. Locks in that the two decisions stay separate.
      const messages = [
        skillToolUse('toolu_y', 'foo'),
        skillToolResult('toolu_y'),
        skillBody('# foo body', false, 'toolu_y'),
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

describe('forked skill kickoff prompt (CLI >= 2.1.265)', () => {
  const skillToolUse = (id: string): JsonlNode =>
    ({
      kind: 'assistant', sessionId: '', receivedAt: '',
      raw: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: 'forkprobe' } }] },
      },
    }) as unknown as JsonlNode;

  const kickoff = (parentId: string): JsonlNode =>
    ({
      kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '',
      raw: {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /x\n\nDo the thing\n' }] },
        parent_tool_use_id: parentId,
        subagent_type: 'general-purpose',
        task_description: 'Use when the user says forkprobe.',
      },
    }) as unknown as JsonlNode;

  // Live-stream only — the persisted transcript has no such line, so before
  // this fix the same session rendered one way live and another on reload.
  it('does not render the kickoff prompt as a user message', () => {
    const tu = skillToolUse('toolu_SKILL_1');
    const out = filterDisplayableMessages([tu, kickoff('toolu_SKILL_1')]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(tu);
  });
});

// The CLI writes its conversation latches into the same JSONL as messages.
// Unclassified, each drew an orange "Unrecognized record" card — 379 of them
// across twelve sessions, all saying `atis-latch`.
describe('CLI sidechannel records', () => {
  const record = (raw: Record<string, unknown>): JsonlNode =>
    ({ kind: 'unknown', sessionId: '', receivedAt: null, raw }) as unknown as JsonlNode;

  const atisLatch = () =>
    record({ type: 'atis-latch', atis: 'e6dcdfec512ad7fa', sessionId: 's1' });

  it('drops a latch record from the transcript', () => {
    expect(filterDisplayableMessages([atisLatch()])).toEqual([]);
  });

  it('drops the rest of the family too, not just the one we noticed', () => {
    const family = ['isolation-latch', 'mode', 'worktree-state', 'cost-state', 'relocated']
      .map((type) => record({ type, sessionId: 's1' }));
    expect(filterDisplayableMessages(family)).toEqual([]);
  });

  it('keeps the compaction summary, which rides the same kind', () => {
    const summary = record({ type: 'summary', summary: 'we did things', leafUuid: 'u1' });
    expect(filterDisplayableMessages([summary])).toHaveLength(1);
  });

  it('still shows a record type it has never seen', () => {
    const novel = record({ type: 'some-future-record', sessionId: 's1' });
    expect(filterDisplayableMessages([novel])).toHaveLength(1);
  });

  it('leaves the messages around a latch untouched', () => {
    const kept = filterDisplayableMessages([userText('hi'), atisLatch(), userText('bye')]);
    expect(kept).toHaveLength(2);
  });
});

// The CLI re-appends `ai-title` after nearly every turn, title unchanged, and
// keeps doing so after a rename — so the raw records repeat and alternate. A
// title row is drawn only where the session's effective title (rename wins,
// see pickSessionTitle) changes.
describe('filterDisplayableMessages — session titles', () => {
  const ai = (aiTitle: string): JsonlNode =>
    ({ kind: 'ai-title', sessionId: 's', raw: { type: 'ai-title', aiTitle, sessionId: 's' } }) as unknown as JsonlNode;
  const custom = (customTitle: string): JsonlNode =>
    ({ kind: 'custom-title', sessionId: 's', raw: { type: 'custom-title', customTitle, sessionId: 's' } }) as unknown as JsonlNode;
  const titles = (nodes: JsonlNode[]): string[] =>
    filterDisplayableMessages(nodes).map((n) =>
      n.kind === 'ai-title' ? `ai:${n.raw.aiTitle}` : n.kind === 'custom-title' ? `custom:${n.raw.customTitle}` : n.kind,
    );

  it('renders a repeated AI title once', () => {
    expect(titles([ai('A'), ai('A'), ai('A'), ai('A'), ai('A')])).toEqual(['ai:A']);
  });

  it('renders each change of AI title once', () => {
    expect(titles([ai('A'), ai('A'), ai('B'), ai('B')])).toEqual(['ai:A', 'ai:B']);
  });

  it('renders a return to an earlier title', () => {
    expect(titles([ai('A'), ai('B'), ai('A')])).toEqual(['ai:A', 'ai:B', 'ai:A']);
  });

  it('lets a rename outrank the AI titles the CLI keeps appending after it', () => {
    expect(titles([ai('A'), ai('A'), custom('X'), ai('A'), custom('X'), ai('A')])).toEqual(['ai:A', 'custom:X']);
  });

  it('leaves other rows in place around the titles', () => {
    const prompt = userText('hi');
    expect(filterDisplayableMessages([ai('A'), prompt, ai('A')])).toEqual([ai('A'), prompt]);
  });

  // Live entries arrive one at a time and the whole list is re-filtered each
  // time; every intermediate result must agree with the final one.
  it('gives entries arriving one by one the same result as a loaded transcript', () => {
    const all = [ai('A'), ai('A'), custom('X'), ai('A'), ai('B'), custom('X'), custom('Y'), ai('B')];
    const final = titles(all);
    expect(final).toEqual(['ai:A', 'custom:X', 'custom:Y']);
    for (let n = 1; n <= all.length; n++) {
      const partial = titles(all.slice(0, n));
      expect(final.slice(0, partial.length)).toEqual(partial);
    }
  });
});

// An attachment the ledger has no one-line summary for renders nothing — and
// an empty row still takes the row's padding, which opened blank gaps in the
// transcript (session 5220766b, both view modes).
describe('filterDisplayableMessages — context attachments', () => {
  const attachment = (attachment: Record<string, unknown>): JsonlNode =>
    ({ kind: 'attachment', sessionId: 's', raw: { type: 'attachment', attachment } }) as unknown as JsonlNode;

  it('drops attachments with nothing to show, keeps the ones with a summary', () => {
    const environment = attachment({ type: 'environment' });
    const date = attachment({ type: 'date' });
    const instructions = attachment({ type: 'instructions', files: [{ path: 'CLAUDE.md' }] });
    expect(filterDisplayableMessages([environment, instructions, date])).toEqual([instructions]);
  });
});
