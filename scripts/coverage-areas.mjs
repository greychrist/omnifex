#!/usr/bin/env node
/** Reporting only: exits non-zero only when there is no report to read, never for a low number. */
import fs from 'node:fs';
import path from 'node:path';

const SUMMARY = path.resolve('coverage/coverage-summary.json');

/** First match wins: `src/components` must precede `src/`. */
const AREAS = [
  { name: 'daemon/**  (daemon)', match: (f) => f.startsWith('daemon/') },
  { name: 'src/components  (React UI)', match: (f) => f.startsWith('src/components/') },
  { name: 'src/**  (renderer logic)', match: (f) => f.startsWith('src/') },
  { name: 'other', match: () => true },
];

const TARGET = 80;

if (!fs.existsSync(SUMMARY)) {
  console.error(
    `No coverage report at ${SUMMARY}.\nRun \`npm run test:coverage\` first.`,
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
const topIdx = argv.indexOf('--top');
const TOP = topIdx !== -1 ? Number.parseInt(argv[topIdx + 1], 10) || 15 : 15;

const summary = JSON.parse(fs.readFileSync(SUMMARY, 'utf8'));
const root = process.cwd() + path.sep;

const files = [];
for (const [abs, data] of Object.entries(summary)) {
  if (abs === 'total') continue;
  const rel = abs.startsWith(root) ? abs.slice(root.length) : abs;
  // No executable lines: would divide by zero and says nothing either way.
  if (!data.lines || data.lines.total === 0) continue;
  files.push({ rel, ...data.lines });
}

const pct = (covered, total) => (total === 0 ? 100 : (100 * covered) / total);
const fmt = (n) => `${n.toFixed(2)}%`.padStart(7);

const buckets = AREAS.map((a) => ({ ...a, files: [] }));
for (const f of files) {
  buckets.find((b) => b.match(f.rel)).files.push(f);
}

console.log('\nLine coverage by area');
console.log('─'.repeat(64));
for (const b of buckets) {
  if (b.files.length === 0) continue;
  const total = b.files.reduce((s, f) => s + f.total, 0);
  const covered = b.files.reduce((s, f) => s + f.covered, 0);
  const p = pct(covered, total);
  const flag = p >= TARGET ? ' ' : '!';
  console.log(
    `${flag} ${fmt(p)}  ${String(total - covered).padStart(5)} uncovered  ` +
      `${String(b.files.length).padStart(4)} files   ${b.name}`,
  );
}

const total = files.reduce((s, f) => s + f.total, 0);
const covered = files.reduce((s, f) => s + f.covered, 0);
const overall = pct(covered, total);
console.log('─'.repeat(64));
console.log(
  `${overall >= TARGET ? ' ' : '!'} ${fmt(overall)}  ` +
    `${String(total - covered).padStart(5)} uncovered  ` +
    `${String(files.length).padStart(4)} files   ALL  (target ${TARGET}%)`,
);

// Ranked by uncovered LINES: a 400-line file at 14% outweighs a 20-line file at 0%.
console.log(`\nBiggest absolute drags (top ${TOP}, by uncovered lines)`);
console.log('─'.repeat(64));
for (const f of files.sort((a, b) => b.total - b.covered - (a.total - a.covered)).slice(0, TOP)) {
  console.log(`  ${String(f.total - f.covered).padStart(5)}  ${fmt(pct(f.covered, f.total))}  ${f.rel}`);
}
console.log();
