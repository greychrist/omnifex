import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Access policy for the `greychrist-file://` scheme.
 *
 * The scheme is registered privileged (`standard`, `secure`, `supportFetchAPI`,
 * `stream`) so the renderer can show images from disk. Its handler used to be
 * an unrestricted read — `fs.readFileSync(decodeURIComponent(url.pathname))`
 * on any absolute path — which made it a local-file read primitive for
 * anything that could run script in the renderer. That is reachable: the
 * transcript auto-offers a preview for any URL printed in command output
 * (`linkDetector.tsx` matches any domain, not just localhost) and the preview
 * is an iframe.
 *
 * Only two call sites construct these URLs — `ImagePreview.tsx:66` and
 * `StreamMessage.tsx:1289` — and both use the result as an `<img src>`. So the
 * scheme only ever needs to serve images, and that is the restriction:
 *
 *  - absolute paths only;
 *  - the file must exist and be a regular file;
 *  - its extension must be a known image type, decided on the path AFTER
 *    symlink resolution, so `decoy.png -> ~/.claude/.credentials.json` is
 *    refused rather than served.
 *
 * Extension-on-realpath is the load-bearing check. A root allowlist was
 * considered and deliberately left out: legitimate images live wherever the
 * user's projects live, so a root list would either be so broad it adds
 * nothing or narrow enough to break ordinary previews. Narrowing roots is
 * still available as defence in depth if the threat model changes.
 */

/** Image extensions the scheme serves, and the content type for each. */
const IMAGE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export const ALLOWED_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.keys(IMAGE_CONTENT_TYPES),
);

export type ProtocolFileDecision =
  | { ok: true; path: string; contentType: string }
  | { ok: false; reason: string };

/**
 * Decide whether `requestedPath` may be served, and resolve it.
 *
 * Returns the REAL path so the caller reads the same file this function
 * approved — resolving here and reading elsewhere would reintroduce the
 * symlink-swap race the check exists to prevent.
 */
export function resolveProtocolFile(requestedPath: string): ProtocolFileDecision {
  if (!requestedPath || !path.isAbsolute(requestedPath)) {
    return { ok: false, reason: 'not an absolute path' };
  }

  // realpathSync resolves `..` segments and every symlink in the chain, so
  // the extension test below applies to the file actually on disk.
  let real: string;
  try {
    real = fs.realpathSync(requestedPath);
  } catch {
    return { ok: false, reason: 'does not exist' };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    return { ok: false, reason: 'not stattable' };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: 'not a regular file' };
  }

  const ext = path.extname(real).toLowerCase();
  const contentType = IMAGE_CONTENT_TYPES[ext];
  if (!contentType) {
    return { ok: false, reason: `extension ${ext || '(none)'} is not a served image type` };
  }

  return { ok: true, path: real, contentType };
}
