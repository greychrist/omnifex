import { tagText } from './xmlTags';

/**
 * Parser for the pseudo-XML envelope the CLI persists in place of a typed
 * slash command.
 *
 * The CLI does not emit one canonical shape. Built-ins persist as
 *
 *   <command-name>/usage</command-name>
 *   <command-message>usage</command-message>
 *   <command-args></command-args>
 *
 * while custom and skill-backed commands persist message-first with no args
 * tag at all:
 *
 *   <command-message>timesheet-review</command-message>
 *   <command-name>/timesheet-review</command-name>
 *
 * A single ordered regex spanning all three tags therefore matches only a
 * minority of real records — across this account's transcripts there are 564
 * <command-name> tags but just 122 <command-args>. Every other record fell
 * through to the plain-text renderer and printed the envelope verbatim. Match
 * each tag independently instead, and treat everything but the name as
 * optional.
 */
export interface CommandEnvelope {
  name: string;
  message: string;
  args?: string;
}

export function parseCommandEnvelope(text: string): CommandEnvelope | null {
  const name = tagText(text, 'command-name');
  if (!name) return null;
  const args = tagText(text, 'command-args');
  return {
    name,
    message: tagText(text, 'command-message') ?? '',
    // An empty <command-args></command-args> means "invoked with no
    // arguments" — the same thing as the tag being absent.
    args: args || undefined,
  };
}

/**
 * The tags the CLI wraps around a *local* command's echo and its stdout. A
 * slash command runs on the client, so what lands in the transcript is a pair
 * of `user` records the model never sees and will never answer:
 *
 *   <command-name>/compact</command-name>   (+ message / args)
 *   <local-command-stdout>Compacted </local-command-stdout>
 *
 * Exported so the classifier and the renderer share one definition of the
 * shape — messageKind needs the two tags apart (it renders them as different
 * cards), the classifier only needs to know it is looking at either.
 */
export const COMMAND_NAME_TAG = '<command-name>';
export const LOCAL_COMMAND_STDOUT_TAG = '<local-command-stdout>';

/**
 * True for either half of a local-command envelope.
 *
 * `content` is accepted in both shapes the CLI persists — a bare string and an
 * array of content blocks — because the same record reaches this code from the
 * live stream and from a re-read transcript, and only one of those normalizes.
 */
export function isLocalCommandEnvelope(content: unknown): boolean {
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text'
        ? String((b as { text?: unknown }).text ?? '')
        : ''))
      .join('');
  } else {
    return false;
  }
  return text.includes(COMMAND_NAME_TAG) || text.includes(LOCAL_COMMAND_STDOUT_TAG);
}
