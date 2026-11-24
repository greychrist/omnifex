import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CaptureFile } from '../mcp-tools';
import type { AdmitVerdict, BrainSource, DistilledItem, SourceItem } from './types';

export const CAPTURE_SOURCE_ID = 'capture';

/** Must match where `brain_remember` writes. */
const CAPTURE_DIR = join('.omnifex', 'capture');

export interface CaptureSourceDeps {
  vaults: () => { accountId: number; root: string }[];
}

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
          // Skip, but don't abandon the vaults after it.
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
            // Vanished between readdir and stat.
          }
        }
      }
      return Promise.resolve(items);
    },

    /** No gate beyond emptiness: a capture is an explicit act, never second-guessed. */
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
