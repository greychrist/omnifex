import { describe, expect, it } from 'vitest';
import { isRequestReplayLine } from '../services/util/request-replay';

describe('isRequestReplayLine', () => {
  it.each(['api-request', 'api-request-shape', 'api-request-blob'])('matches a %s record', (type) => {
    expect(isRequestReplayLine(JSON.stringify({ type, sessionId: 's' }))).toBe(true);
  });

  it('tolerates leading whitespace', () => {
    expect(isRequestReplayLine('  {"type":"api-request","id":"x"}')).toBe(true);
  });

  it.each([
    JSON.stringify({ type: 'assistant', message: { content: 'api-request' } }),
    JSON.stringify({ type: 'api-requested' }),
    JSON.stringify({ type: 'user', note: '{"type":"api-request"}' }),
    '',
    'not json',
  ])('does not match %s', (line) => {
    expect(isRequestReplayLine(line)).toBe(false);
  });
});
