export const BRANCH_COLORS_PALETTE = [
  '#3b82f6', // blue (also the main-folder default)
  '#a78bfa', // violet
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#ef4444', // red
  '#84cc16', // lime
];

const MAIN_FOLDER_BLUE = '#3b82f6';
const TRUNK_NAMES = new Set(['main', 'master']);

export interface ResolveInput {
  pins: Record<string, string>;
  mainFolderBranch: string | null;
  branches: string[];
}

export interface ResolveOutput {
  colors: Record<string, string>;
  trunkBlack: Set<string>;
}

function hashColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return BRANCH_COLORS_PALETTE[Math.abs(hash) % BRANCH_COLORS_PALETTE.length];
}

export function resolveBranchColors(input: ResolveInput): ResolveOutput {
  const colors: Record<string, string> = {};
  const trunkBlack = new Set<string>();
  const used = new Set<string>();

  for (const branch of input.branches) {
    const pinned = input.pins[branch];
    if (pinned) {
      colors[branch] = pinned;
      used.add(pinned);
      continue;
    }
    if (TRUNK_NAMES.has(branch)) {
      trunkBlack.add(branch);
      continue;
    }
    if (input.mainFolderBranch && branch === input.mainFolderBranch) {
      colors[branch] = MAIN_FOLDER_BLUE;
      used.add(MAIN_FOLDER_BLUE);
      continue;
    }
    const next = BRANCH_COLORS_PALETTE.find((c) => !used.has(c));
    if (next) {
      colors[branch] = next;
      used.add(next);
    } else {
      colors[branch] = hashColor(branch);
    }
  }

  return { colors, trunkBlack };
}
