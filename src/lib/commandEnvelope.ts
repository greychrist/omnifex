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

function tag(text: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return match ? match[1].trim() : undefined;
}

export function parseCommandEnvelope(text: string): CommandEnvelope | null {
  const name = tag(text, 'command-name');
  if (!name) return null;
  const args = tag(text, 'command-args');
  return {
    name,
    message: tag(text, 'command-message') ?? '',
    // An empty <command-args></command-args> means "invoked with no
    // arguments" — the same thing as the tag being absent.
    args: args || undefined,
  };
}
