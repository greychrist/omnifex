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
