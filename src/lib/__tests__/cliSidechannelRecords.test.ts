import { describe, it, expect } from 'vitest';
import {
  CLI_SIDECHANNEL_RECORD_TYPES,
  isCliSidechannelRecord,
} from '../cliSidechannelRecords';

describe('isCliSidechannelRecord', () => {
  it('recognises the latch that started this: atis-latch', () => {
    expect(
      isCliSidechannelRecord({
        type: 'atis-latch',
        atis: 'e6dcdfec512ad7fa',
        sessionId: '278981fd-8fbb-40dd-ac38-4b0a2371ca4f',
      }),
    ).toBe(true);
  });

  // CLI 2.1.317: the account and org owning the session; `last-wins`, re-stamped
  // on every metadata re-append.
  it('recognises session-owner', () => {
    expect(
      isCliSidechannelRecord({
        type: 'session-owner',
        accountUuid: 'd624eb4c-4173-418b-83e7-2ffed2f968a1',
        organizationUuid: '1f464584-bab8-4dba-bb30-a9e806c9f39b',
        sessionId: '39eddbbf-781f-4758-b58e-af2d408ea20f',
      }),
    ).toBe(true);
  });

  // CLI 2.1.318: whether the session runs in Code Mode; not in the merge map.
  it('recognises repl-mode', () => {
    expect(
      isCliSidechannelRecord({
        type: 'repl-mode',
        replMode: true,
        sessionId: '39eddbbf-781f-4758-b58e-af2d408ea20f',
      }),
    ).toBe(true);
  });

  // CLI 2.1.319: a checksum vouching for the transcript head a resume loaded
  // (`boundary-cleared`).
  it('recognises resume-head-vouch', () => {
    expect(
      isCliSidechannelRecord({
        type: 'resume-head-vouch',
        sessionId: '39eddbbf-781f-4758-b58e-af2d408ea20f',
        sum: 'a1b2c3',
      }),
    ).toBe(true);
  });

  // CLI 2.1.276: memory on/off at a point in the conversation. `accumulate`, so
  // several land per session.
  it('recognises memory-mode', () => {
    expect(
      isCliSidechannelRecord({
        type: 'memory-mode',
        mode: 'off',
        afterUuid: null,
        timestamp: '2026-09-18T00:00:00.000Z',
        sessionId: '278981fd-8fbb-40dd-ac38-4b0a2371ca4f',
      }),
    ).toBe(true);
  });

  // CLI 2.1.282: request-replay records, one `api-request` per model call while
  // `tengu_elegant_meadow` is on (`boundary-cleared`).
  it('recognises the 2.1.282 request-replay records', () => {
    for (const type of ['api-request', 'api-request-shape', 'api-request-blob']) {
      expect(isCliSidechannelRecord({ type, sessionId: 's' })).toBe(true);
    }
    expect(
      isCliSidechannelRecord({
        type: 'api-request-blob',
        sessionId: 's',
        hash: 'h',
        message: { role: 'user', content: 'hi' },
      }),
    ).toBe(true);
  });

  // CLI 2.1.328: `api-request-resumed`, same merge strategy and gate as
  // `api-request`.
  it('recognises the 2.1.328 api-request-resumed record', () => {
    expect(
      isCliSidechannelRecord({
        type: 'api-request-resumed',
        sessionId: 's',
        messageId: 'msg_1',
        pausedRequestId: 'req_1',
        resumedRequestId: 'req_2',
      }),
    ).toBe(true);
  });

  // CLI 2.1.329: `hybrid-organization`, written with the session metadata and
  // into subagent files; `last-wins`.
  it('recognises the 2.1.329 hybrid-organization record', () => {
    expect(
      isCliSidechannelRecord({
        type: 'hybrid-organization',
        organizationUuid: 'org-1',
        sessionId: 's',
      }),
    ).toBe(true);
  });

  // CLI 2.1.330: `host-row`, one per Code Mode script call, routed by `agentId`.
  it('recognises the 2.1.330 host-row record', () => {
    expect(
      isCliSidechannelRecord({
        type: 'host-row',
        sessionId: 's',
        timestamp: '2026-11-20T00:00:00.000Z',
        ranByToolUseId: 'toolu_1',
      }),
    ).toBe(true);
  });

  // CLI 2.1.283: the session's dev-mods folder; `last-wins`.
  it('recognises dev-mods', () => {
    expect(
      isCliSidechannelRecord({
        type: 'dev-mods',
        folder: '278981fd-8fbb-40dd-ac38-4b0a2371ca4f',
        sessionId: '278981fd-8fbb-40dd-ac38-4b0a2371ca4f',
      }),
    ).toBe(true);
  });

  // CLI 2.1.311: every tool called so far, re-written whenever the set grows.
  it('recognises tools-used', () => {
    expect(
      isCliSidechannelRecord({
        type: 'tools-used',
        tools: ['mcp__omnifex__progress', 'Bash'],
        sessionId: 'f43f8eb9-91dd-4f31-bfa0-b87e57667ebe',
      }),
    ).toBe(true);
  });

  // CLI 2.1.323, behind `tengu_pewter_grebe` + `allow_data_flow`: data-flow
  // provenance (`accumulate`) and derived-from sessions (`last-wins`).
  it('recognises the 2.1.323 data-flow records', () => {
    expect(
      isCliSidechannelRecord({ type: 'data-flow-records', v: 1, sessionId: 's', records: [] }),
    ).toBe(true);
    expect(isCliSidechannelRecord({ type: 'data-flow-incomplete', v: 1, sessionId: 's' })).toBe(true);
    expect(
      isCliSidechannelRecord({
        type: 'derived-from',
        v: 1,
        sessionId: 's',
        sessions: [{ type: 'claude_code_session', id: 'x', via: 'fork' }],
      }),
    ).toBe(true);
  });

  it('never claims one of the four transcript types', () => {
    for (const type of ['user', 'assistant', 'system', 'attachment']) {
      expect(isCliSidechannelRecord({ type })).toBe(false);
    }
  });

  it('leaves the records OmniFex classifies for itself alone', () => {
    for (const type of [
      'queue-operation',
      'last-prompt',
      'permission-mode',
      'ai-title',
      'custom-title',
      'file-history-snapshot',
    ]) {
      expect(CLI_SIDECHANNEL_RECORD_TYPES.has(type)).toBe(false);
    }
  });

  it('leaves `summary` alone — it renders as the compaction card', () => {
    expect(isCliSidechannelRecord({ type: 'summary', summary: 'x', leafUuid: 'y' })).toBe(false);
  });

  it('does not guess at a type it has never heard of', () => {
    expect(isCliSidechannelRecord({ type: 'some-future-record' })).toBe(false);
  });

  it('tolerates junk', () => {
    expect(isCliSidechannelRecord(null)).toBe(false);
    expect(isCliSidechannelRecord('atis-latch')).toBe(false);
    expect(isCliSidechannelRecord({})).toBe(false);
    expect(isCliSidechannelRecord({ type: 42 })).toBe(false);
  });
});
