/**
 * Explicit captures written by the MCP server's `brain_remember`.
 *
 * Ownership needs no resolution here at all: a capture file sits INSIDE one
 * account's vault, so the owning account is a property of the path. This is
 * the strongest form of the rule the session adapter has to approximate with
 * `getAccountByConfigDir` — there is nothing to guess and nothing to default.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CaptureFile } from '../mcp-tools';
import type { AdmitVerdict, BrainSource, DistilledItem, SourceItem } from './types';

export const CAPTURE_SOURCE_ID = 'capture';

/** Relative to a vault root. Matches the path `brain_remember` writes to. */
const CAPTURE_DIR = join('.omnifex', 'capture');

export interface CaptureSourceDeps {
  /** The configured vaults, each with the account that owns it. */
  vaults: () => { accountId: number; root: string }[];
}

/** Null for anything that is not a readable capture — never a throw. */
function readCapture(path: string): CaptureFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CaptureFile>;
    if (typeof parsed.text !== 'string') return null;
    return {
      id: typeof parsed.id === 'string' ? parsed.id : '',
      text: parsed.text,
      project: typeof parsed.project === 'string' ? parsed.project : null,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : null,
      capturedAt: typeof parsed.capturedAt === 'string' ? parsed.capturedAt : '',
    };
  } catch {
    return null;
  }
}

export function createCaptureSource(deps: CaptureSourceDeps): BrainSource {
  return {
    id: CAPTURE_SOURCE_ID,

    discover(): Promise<SourceItem[]> {
      const items: SourceItem[] = [];
      for (const { accountId, root } of deps.vaults()) {
        const dir = join(root, CAPTURE_DIR);
        let names: string[];
        try {
          names = readdirSync(dir).filter((n) => n.endsWith('.json'));
        } catch {
          // No captures for this vault yet. Not an error, and not a reason to
          // abandon the vaults after it in the list.
          continue;
        }
        for (const name of names) {
          const path = join(dir, name);
          try {
            const stat = statSync(path);
            items.push({
              sourceId: CAPTURE_SOURCE_ID,
              itemKey: name.slice(0, -'.json'.length),
              accountId,
              path,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              label: readCapture(path)?.project ?? 'capture',
            });
          } catch {
            // A file that vanished between readdir and stat is not an error.
          }
        }
      }
      return Promise.resolve(items);
    },

    /**
     * There is no equivalent of the session gate's two-prompt rule. A capture
     * is an explicit act by the user or the model on their behalf, and
     * second-guessing it would make the tool untrustworthy — the only thing
     * rejected here is a file that carries nothing to extract.
     */
    admit(item: SourceItem): AdmitVerdict {
      const capture = readCapture(item.path);
      if (!capture) return { admitted: false, reason: 'capture file is unreadable or malformed' };
      if (!capture.text.trim()) return { admitted: false, reason: 'capture text is empty' };
      return { admitted: true, reason: 'explicit capture' };
    },

    distill(item: SourceItem): Promise<DistilledItem> {
      const capture = readCapture(item.path);
      if (!capture) throw new Error(`capture file is unreadable: ${item.path}`);
      return Promise.resolve({
        // The captured text IS the prose. No model, no truncation — a capture
        // is already the distillation a session needs one to produce.
        prose: capture.text.trim(),
        truncated: false,
        metadata: {
          kind: 'capture',
          capturedAt: capture.capturedAt,
          project: capture.project,
          cwd: capture.cwd,
        },
      });
    },
  };
}
