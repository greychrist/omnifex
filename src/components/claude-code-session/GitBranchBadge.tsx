import * as React from 'react';
import { GitBranch, FilePen, FilePlus } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface GitBranchBadgeProps {
  name: string;
  changed: number;
  untracked: number;
  /** Resolved hex color for non-trunk chips. Ignored when `isTrunk` is true. */
  color: string | null;
  /** When true, render the black trunk style (overrides `color`). */
  isTrunk: boolean;
}

// WCAG relative luminance — used to flip the chip to a solid bg + white text
// when the user picks a color that's too dark to read against the dark theme.
// Threshold is empirical: anything darker than mid-tone gets the inverted style.
function isDarkColor(hex: string): boolean {
  const m = hex.replace('#', '');
  if (m.length !== 6) return false;
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L < 0.35;
}

export const GitBranchBadge: React.FC<GitBranchBadgeProps> = ({
  name,
  changed,
  untracked,
  color,
  isTrunk,
}) => {
  const titleParts = [`Git branch: ${name}`];
  if (changed > 0) titleParts.push(`${changed} changed`);
  if (untracked > 0) titleParts.push(`${untracked} untracked`);

  const useColor = !isTrunk && color != null;
  const dark = useColor && isDarkColor(color!);

  // For light/medium colors keep the translucent tint (20% bg / 30% border /
  // saturated text). For dark colors that translucency is invisible on the
  // dark page bg, so bump the bg alpha and flip the text to white — still
  // translucent (~80%), still readable.
  const inlineStyle = useColor
    ? dark
      ? { backgroundColor: `${color}cc`, color: '#ffffff', borderColor: color! }
      : { backgroundColor: `${color}33`, color: color!, borderColor: `${color}4d` }
    : undefined;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-mono font-medium',
        isTrunk && 'bg-black text-white border-black',
      )}
      style={inlineStyle}
      title={titleParts.join(' · ')}
    >
      <GitBranch className="w-3.5 h-3.5" />
      {name}
      {(changed > 0 || untracked > 0) && (
        <span aria-hidden className="h-3 w-px bg-current opacity-40 mx-0.5" />
      )}
      {changed > 0 && (
        <span className="inline-flex items-center gap-0.5 text-emerald-400">
          <FilePen className="w-3 h-3" />
          {changed}
        </span>
      )}
      {untracked > 0 && (
        <span className="inline-flex items-center gap-0.5 text-amber-300">
          <FilePlus className="w-3 h-3" />
          {untracked}
        </span>
      )}
    </span>
  );
};
