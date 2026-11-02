/**
 * What a drop onto the chat turns into.
 *
 * - An image Claude can take inline (PNG, JPEG, GIF, WebP) goes in as a paste
 *   would: a data URL beside the prompt.
 * - Anything else with a real path (the Mac app reports it over
 *   `drop:paths`; WebKit never tells the page) becomes an `@path` mention,
 *   so Claude reads, and can edit, the file where it lives. A path with no
 *   file behind it is a dropped folder, mentioned the same way.
 * - Anything else without a path (dragged from a browser, the iPad) is
 *   copied by the daemon (`save_dropped_file`) and the copy is mentioned.
 *
 * SVG is not inline-able: the Messages API takes four raster types only,
 * and an SVG is text Claude reads fine from a path.
 */

export interface DroppedFileLike {
  name: string;
  type: string;
}

export type DropAction<F extends DroppedFileLike> =
  | { kind: 'image'; file: F }
  | { kind: 'mention'; path: string }
  | { kind: 'copy'; file: F };

const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const INLINE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

export function isInlineImage(file: DroppedFileLike): boolean {
  if (INLINE_TYPES.has(file.type)) return true;
  if (file.type) return false;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return INLINE_EXTENSIONS.has(ext);
}

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

export function planDrop<F extends DroppedFileLike>(files: F[], nativePaths: string[]): DropAction<F>[] {
  const unmatched = [...files];
  const actions: DropAction<F>[] = [];
  for (const path of nativePaths) {
    const i = unmatched.findIndex((f) => f.name === basename(path));
    const file = i >= 0 ? unmatched.splice(i, 1)[0] : undefined;
    actions.push(file && isInlineImage(file) ? { kind: 'image', file } : { kind: 'mention', path });
  }
  for (const file of unmatched) {
    actions.push(isInlineImage(file) ? { kind: 'image', file } : { kind: 'copy', file });
  }
  return actions;
}

/** `@path`, quoted when the path has whitespace (the CLI's `@"…"` form). */
export function mentionFor(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/** Appends `path` as a mention, unless the prompt already names it. */
export function appendMention(prompt: string, path: string): string {
  const mention = mentionFor(path);
  if (prompt.split(/\s+/).includes(mention) || prompt.includes(`${mention} `)) return prompt;
  const sep = prompt === '' || /\s$/.test(prompt) ? '' : ' ';
  return `${prompt}${sep}${mention} `;
}
