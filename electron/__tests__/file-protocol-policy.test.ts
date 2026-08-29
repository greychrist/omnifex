import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveProtocolFile, ALLOWED_IMAGE_EXTENSIONS } from '../file-protocol-policy';

/**
 * `greychrist-file://` used to be an unrestricted file read: the handler did
 * `fs.readFileSync(decodeURIComponent(url.pathname))` on whatever path came in.
 * Combined with the scheme being registered `supportFetchAPI: true` WITHOUT
 * `corsEnabled`, any page that got script into the renderer (the preview
 * iframe is auto-offered for any URL printed in command output) could
 * `fetch('greychrist-file:///…/.credentials.json')` and read account tokens.
 *
 * The scheme exists to render images in the transcript — `ImagePreview.tsx:66`
 * and `StreamMessage.tsx:1289` are its only two consumers, and both use it as
 * an `<img src>`. So the policy is: image extensions only, decided on the
 * REAL path after symlink resolution.
 */

let dir: string;
let realImage: string;
let secret: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-protocol-'));
  realImage = path.join(dir, 'shot.png');
  secret = path.join(dir, '.credentials.json');
  fs.writeFileSync(realImage, 'png-bytes');
  fs.writeFileSync(secret, '{"token":"secret"}');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveProtocolFile', () => {
  it('serves a real image and reports its content type', () => {
    const res = resolveProtocolFile(realImage);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.contentType).toBe('image/png');
    expect(res.path).toBe(fs.realpathSync(realImage));
  });

  it('refuses a credentials file — the payload of the original bug', () => {
    const res = resolveProtocolFile(secret);
    expect(res.ok).toBe(false);
  });

  it('refuses a transcript .jsonl', () => {
    const jsonl = path.join(dir, 'session.jsonl');
    fs.writeFileSync(jsonl, '{}');
    expect(resolveProtocolFile(jsonl).ok).toBe(false);
  });

  it('refuses an extensionless file', () => {
    const none = path.join(dir, 'id_rsa');
    fs.writeFileSync(none, 'key');
    expect(resolveProtocolFile(none).ok).toBe(false);
  });

  it('decides on the RESOLVED path, so an image-named symlink to a secret is refused', () => {
    const link = path.join(dir, 'decoy.png');
    fs.symlinkSync(secret, link);
    // The link itself ends .png — only realpath resolution catches this.
    expect(path.extname(link)).toBe('.png');
    expect(resolveProtocolFile(link).ok).toBe(false);
  });

  it('refuses traversal that climbs out via ..', () => {
    const climb = path.join(dir, 'sub', '..', '..', '..', 'etc', 'passwd');
    expect(resolveProtocolFile(climb).ok).toBe(false);
  });

  it('refuses a relative path', () => {
    expect(resolveProtocolFile('shot.png').ok).toBe(false);
  });

  it('refuses a directory that happens to end in .png', () => {
    const dirPng = path.join(dir, 'folder.png');
    fs.mkdirSync(dirPng);
    expect(resolveProtocolFile(dirPng).ok).toBe(false);
  });

  it('refuses a file that does not exist', () => {
    expect(resolveProtocolFile(path.join(dir, 'missing.png')).ok).toBe(false);
  });

  it('matches the extension case-insensitively', () => {
    const upper = path.join(dir, 'SHOT.PNG');
    fs.writeFileSync(upper, 'png-bytes');
    const res = resolveProtocolFile(upper);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.contentType).toBe('image/png');
  });

  it('covers exactly the extensions the old handler had content types for', () => {
    expect([...ALLOWED_IMAGE_EXTENSIONS].sort()).toEqual(
      ['.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'].sort(),
    );
  });

  it('never falls back to application/octet-stream', () => {
    // The old handler served ANY extension as octet-stream. Nothing reaches
    // a served response now without a real image content type.
    for (const ext of ALLOWED_IMAGE_EXTENSIONS) {
      const f = path.join(dir, `probe${ext}`);
      fs.writeFileSync(f, 'x');
      const res = resolveProtocolFile(f);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.contentType.startsWith('image/')).toBe(true);
    }
  });
});
