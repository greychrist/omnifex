/**
 * Request replay — the CLI's `api-request`, `api-request-shape` and
 * `api-request-blob` transcript records (CLI >= 2.1.282, on by default since
 * 2.1.300). Each `api-request` repeats the full request params, and in auto
 * mode those carry a classifier context that grows ~0.8 KB per model call up
 * to a 256 KB ceiling, so a long session's transcript is mostly these. Nothing
 * in OmniFex reads them.
 *
 * Two defences, because sessions OmniFex did not spawn still write them:
 *
 *  - `REQUEST_REPLAY_ENV`, set to `'0'` by `buildClaudeEnv`, stops the CLI
 *    writing them at all. It is a tri-bool read before the
 *    `tengu_elegant_meadow` flag. Undocumented, so it can be renamed.
 *  - `isRequestReplayLine` lets a transcript reader drop the line before
 *    `JSON.parse`, so a terminal-spawned transcript costs its readers (and the
 *    renderer, which only ever filtered them out) nothing.
 *
 * The renderer still lists the three types in `cliSidechannelRecords.ts`: that
 * is the backstop if the CLI ever writes `type` anywhere but first.
 */
export const REQUEST_REPLAY_ENV = 'CLAUDE_CODE_ELEGANT_MEADOW';

const REQUEST_REPLAY_LINE = /^\s*\{"type":"api-request(?:-shape|-blob)?"/;

/** Whether a raw JSONL line is a request-replay record. Never parses. */
export function isRequestReplayLine(line: string): boolean {
  return REQUEST_REPLAY_LINE.test(line);
}
