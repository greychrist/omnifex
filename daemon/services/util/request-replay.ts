/**
 * Two defences, since sessions OmniFex did not spawn still write these records: REQUEST_REPLAY_ENV = '0' stops
 * the CLI writing them (undocumented, may be renamed), and isRequestReplayLine drops them before JSON.parse.
 */
export const REQUEST_REPLAY_ENV = 'CLAUDE_CODE_ELEGANT_MEADOW';

const REQUEST_REPLAY_LINE = /^\s*\{"type":"api-request(?:-shape|-blob|-resumed)?"/;

export function isRequestReplayLine(line: string): boolean {
  return REQUEST_REPLAY_LINE.test(line);
}
