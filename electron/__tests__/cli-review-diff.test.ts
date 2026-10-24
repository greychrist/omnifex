import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EXTRACTORS,
  RENDERED_FROM_UNKNOWN,
  USAGE_ANCHORS,
  coverage,
  diffSets,
  extractMergeMap,
  loadInventory,
  runReview,
} from '../../scripts/cli-review-diff';

const REPO = path.resolve(__dirname, '../..');

function extractor(name: string) {
  const e = EXTRACTORS.find((x) => x.name === name);
  if (!e) throw new Error(`no extractor ${name}`);
  return e;
}

/** A minimal stand-in for a CLI bundle: just the literals the checks read. */
function fakeBundle(extra = ''): string {
  return [
    // Bare keys where the minifier allows them, quoted where hyphenated — as
    // the real bundle writes it.
    'var M={user:"transcript",assistant:"transcript",system:"transcript",',
    'attachment:"transcript","atis-latch":"latest","ai-title":"latest"};',
    'x={hook_event_name:"PreToolUse"};x={hook_event_name:"Stop"};',
    'y={type:"control_request"};y={type:"control_response"};',
    'this.request({subtype:"interrupt"});this.request({subtype:"set_model"});',
    'z.option("--resume <id>");z.option("-p, --print");',
    'q.describe("A host wrapping keyboard input must stamp it");',
    'r={subtype:"init"};r={subtype:"success"};',
    'u={origin:{kind:"human"}};u={origin:{kind:"sdk"}};',
    'c={type:"control_request",request:{subtype:"can_use_tool",tool_name:t,input:i,...s&&{permission_suggestions:s}}};',
    extra,
  ].join('\n');
}

describe('extractMergeMap', () => {
  it('widens from a known key to the enclosing object, keeping strategies', () => {
    expect(extractMergeMap(fakeBundle())).toEqual([
      'ai-title=latest',
      'assistant=transcript',
      'atis-latch=latest',
      'attachment=transcript',
      'system=transcript',
      'user=transcript',
    ]);
  });

  it('still finds the map when the first anchor key has gone', () => {
    const text = 'var M={"user":"transcript","custom-title":"latest","x-new":"latest"};';
    expect(extractMergeMap(text)).toContain('x-new=latest');
  });

  it('returns [] when no anchor resolves to a map with transcript entries', () => {
    expect(extractMergeMap('nothing here')).toEqual([]);
  });
});

describe('EXTRACTORS', () => {
  it('reads the literal sets the review diffs', () => {
    const t = fakeBundle();
    expect(extractor('hook_event_name').extract(t)).toEqual(['PreToolUse', 'Stop']);
    expect(extractor('control envelopes').extract(t)).toEqual(['control_request', 'control_response']);
    expect(extractor('SDK control requests').extract(t)).toEqual(['interrupt', 'set_model']);
    expect(extractor('CLI flags').extract(t)).toEqual(['--print', '--resume']);
    expect(extractor('.describe() strings').extract(t)).toEqual([
      'A host wrapping keyboard input must stamp it',
    ]);
    expect(extractor('origin kinds').extract(t)).toEqual(['human', 'sdk']);
    expect(extractor('can_use_tool payload keys').extract(t)).toEqual(
      ['input', 'permission_suggestions', 'tool_name'],
    );
    expect(extractor('object keys').extract(t)).toEqual(
      expect.arrayContaining(['hook_event_name', 'tool_name', 'permission_suggestions']),
    );
    expect(extractor('subtype literals').extract(t)).toEqual(
      expect.arrayContaining(['init', 'success', 'interrupt']),
    );
  });
});

describe('diffSets', () => {
  it('reports both directions', () => {
    expect(diffSets(['a', 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'] });
  });
});

describe('USAGE_ANCHORS', () => {
  // The list is the script's copy of what the /usage scraper keys on. If the
  // parser stops using an anchor, the review would count a string nobody
  // reads; this keeps the copy honest.
  it('is drawn from strings the /usage parser actually contains', () => {
    const parser = fs.readFileSync(path.join(REPO, 'electron/services/usage-runner/parser.ts'), 'utf8');
    for (const a of USAGE_ANCHORS) expect(parser).toContain(a);
  });
});

describe('RENDERED_FROM_UNKNOWN', () => {
  it('names only types StreamMessage really draws from the unknown kind', () => {
    const sm = fs.readFileSync(path.join(REPO, 'src/components/StreamMessage.tsx'), 'utf8');
    for (const t of RENDERED_FROM_UNKNOWN) expect(sm).toContain(`unknownRaw.type === "${t}"`);
  });
});

describe('loadInventory (bound to the real code)', () => {
  it('finds what OmniFex sends and passes, wherever it is sent from', async () => {
    const inv = await loadInventory(REPO);
    // queries.ts, lifecycle.ts, models.ts and the engine all send; a pointer
    // at one file is how the old prompt under-counted.
    for (const s of ['side_question', 'rename_session', 'apply_flag_settings', 'initialize',
      'generate_session_title', 'interrupt', 'mcp_toggle']) {
      expect(inv.controlSubtypesSent).toContain(s);
    }
    for (const f of ['--permission-prompt-tool', '--resume', '--input-format', '--mcp-config']) {
      expect(inv.cliFlagsPassed).toContain(f);
    }
    expect(inv.hookEvents).toContain('PreToolUse');
    expect(inv.isUnrecognizedRecord('atis-latch')).toBe(false);
    expect(inv.isUnrecognizedRecord('user')).toBe(false);
    expect(inv.isUnrecognizedRecord('summary')).toBe(false);
    expect(inv.isUnrecognizedRecord('brand-new-record')).toBe(true);
  });
});

describe('coverage', () => {
  it('flags gaps between the installed binary and OmniFex', async () => {
    const inv = await loadInventory(REPO);
    const text = fakeBundle('x={hook_event_name:"BrandNewHook"};').replace(
      '"ai-title":"latest"', '"ai-title":"latest","brand-new-record":"latest"');
    const findings = Object.fromEntries(coverage(text, inv).map((f) => [f.check, f.items]));
    // Only the new bookkeeping type: the four transcript types are the
    // classifier's own cases, whatever a fieldless probe of them returns.
    expect(findings['record types OmniFex would draw as Unrecognized']).toEqual(['brand-new-record']);
    expect(findings['hook events missing from HOOK_EVENTS']).toContain('BrandNewHook');
    // The fake bundle knows neither, so both must surface as possibly broken.
    expect(findings['control subtypes we send that the binary lacks']).toContain('side_question');
    expect(findings['CLI flags we pass that the binary lacks']).toContain('--permission-prompt-tool');
    // `set_model` is catalogued; a request the catalog has never classified
    // is what a review must decide on.
    expect(findings['SDK control requests not in the catalog']).toEqual([]);
    const withNew = coverage(`${text}\nthis.request({subtype:"brand_new_request"});`, inv);
    expect(withNew.find((f) => f.check === 'SDK control requests not in the catalog')?.items)
      .toEqual(['brand_new_request']);
  });
});

describe('runReview', () => {
  function tmpVersions(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-review-diff-'));
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    return dir;
  }

  it('diffs two versions and reports each set as same or moved', async () => {
    const dir = tmpVersions({
      '1.0.0': fakeBundle(),
      '1.0.1': fakeBundle('x={hook_event_name:"BrandNewHook"};'),
    });
    const { report, anchorsMissing } = await runReview({
      from: '1.0.0', to: '1.0.1', versionsDir: dir, repoRoot: REPO,
    });
    expect(report).toMatch(/hook_event_name: \+1 -0/);
    expect(report).toContain('+ BrandNewHook');
    expect(report).toMatch(/control envelopes: same \(2\)/);
    expect(anchorsMissing).toEqual([]);
  });

  it('names a check whose anchor found nothing, rather than reporting it clean', async () => {
    const dir = tmpVersions({ '1.0.0': 'empty', '1.0.1': 'empty' });
    const { report, anchorsMissing } = await runReview({
      from: '1.0.0', to: '1.0.1', versionsDir: dir, repoRoot: REPO,
    });
    expect(anchorsMissing).toContain('merge-strategy map');
    expect(report).toContain('ANCHOR NOT FOUND');
  });

  it('caps long lists unless asked for all of them', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `k={newKey${i}:1};`).join('');
    const dir = tmpVersions({ '1.0.0': fakeBundle(), '1.0.1': fakeBundle(many) });
    const capped = await runReview({ from: '1.0.0', to: '1.0.1', versionsDir: dir, repoRoot: REPO });
    expect(capped.report).toMatch(/… 20 more \(--full lists all\)/);
    const full = await runReview({ from: '1.0.0', to: '1.0.1', versionsDir: dir, repoRoot: REPO, full: true });
    expect(full.report).toContain('+ newKey59');
  });

  it('runs coverage alone when the older version is not installed', async () => {
    const dir = tmpVersions({ '1.0.1': fakeBundle() });
    const { report } = await runReview({
      from: '1.0.0', to: '1.0.1', versionsDir: dir, repoRoot: REPO,
    });
    expect(report).toContain('1.0.0 is not installed');
    expect(report).toContain('hook events missing from HOOK_EVENTS');
  });
});
