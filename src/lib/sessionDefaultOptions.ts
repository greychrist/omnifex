import type { AccountEngine } from '@/lib/api';

export interface DropdownOption {
  id: string;
  label: string;
  description?: string;
}

export const MODEL_OPTIONS: Record<AccountEngine, DropdownOption[]> = {
  claude: [
    { id: 'opus[1m]', label: 'Opus (1M)' },
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet[1m]', label: 'Sonnet (1M)' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' },
  ],
  codex: [
    { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
    { id: 'gpt-5', label: 'GPT-5' },
    { id: 'o3', label: 'o3' },
  ],
};

export const EFFORT_OPTIONS: Record<AccountEngine, DropdownOption[]> = {
  claude: [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra High' },
    { id: 'max', label: 'Max' },
  ],
  codex: [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
  ],
};

export const PERMISSION_OPTIONS: Record<AccountEngine, DropdownOption[]> = {
  claude: [
    { id: 'default', label: 'Default', description: 'Prompt per tool' },
    { id: 'acceptEdits', label: 'Accept Edits', description: 'Accept file edits without prompting' },
    { id: 'plan', label: 'Plan', description: 'Plan only — no tool execution' },
    { id: 'bypassPermissions', label: 'Bypass', description: 'Allow all tools' },
  ],
  codex: [
    { id: 'read-only', label: 'Read-only', description: 'Read files but no edits or exec' },
    { id: 'workspace-edit', label: 'Workspace-edit', description: 'Edit within workspace; exec needs approval' },
    { id: 'full-access', label: 'Full-access', description: 'No sandbox; danger mode' },
  ],
};

export const THINKING_OPTIONS: DropdownOption[] = [
  { id: 'adaptive', label: 'Adaptive' },
  { id: 'disabled', label: 'Disabled' },
];
