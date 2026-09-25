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

  // New in CLI 2.1.276: a latch recording whether memory was on or off at a
  // point in the conversation. `accumulate` in the CLI's merge map, so it is a
  // log, not a last-wins latch — several land per session once the user
  // toggles memory, and nothing in OmniFex reads memory state.
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

  // New in CLI 2.1.282: request-replay records — the exact API request
  // (`api-request`), its deduplicated system+tools shape and message blobs.
  // `boundary-cleared` in the CLI's merge map. Written only while the
  // `tengu_elegant_meadow` flag is on, one `api-request` per model call, so
  // unlisted they would draw a card per API request. `api-request-blob`
  // carries a `message`, but it is a request param, not a turn.
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

  // New in CLI 2.1.283: a latch naming the session's plugin "dev mods"
  // folder (`<config>/dev-mods/<sessionId>`, hot-reloaded as a plugin dir).
  // `last-wins` in the CLI's merge map; written when dev mods are enabled
  // and re-emitted on branch writes, like every other latch.
  it('recognises dev-mods', () => {
    expect(
      isCliSidechannelRecord({
        type: 'dev-mods',
        folder: '278981fd-8fbb-40dd-ac38-4b0a2371ca4f',
        sessionId: '278981fd-8fbb-40dd-ac38-4b0a2371ca4f',
      }),
    ).toBe(true);
  });

  it('never claims one of the four transcript types', () => {
    for (const type of ['user', 'assistant', 'system', 'attachment']) {
      expect(isCliSidechannelRecord({ type })).toBe(false);
    }
  });

  // These are bookkeeping to the CLI too, but the app reads every one of
  // them. Listing one here would silently delete a feature.
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

  // An unfamiliar record is worth seeing once; that is what the catch-all
  // card is for. This list only silences the ones we have identified.
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
