import { describe, it, expect } from 'vitest';
import type { SystemRaw } from '@/types/jsonl';
import { systemRecordText } from '../recordText';

const status = (fields: Record<string, unknown>) =>
  ({ type: 'system', subtype: 'status', ...fields }) as unknown as SystemRaw;

describe('systemRecordText — status frames', () => {
  it('names the phase', () => {
    expect(systemRecordText(status({ status: 'requesting' }), 'status')).toBe('requesting');
    expect(systemRecordText(status({ status: 'compacting' }), 'status')).toBe('compacting');
  });

  it("adds an automatic compaction's streamed characters", () => {
    expect(systemRecordText(status({ status: 'compacting', compact_output_chars: 12345 }), 'status')).toBe('compacting · 12,345 chars');
  });

  it('says how a compaction ended', () => {
    expect(systemRecordText(status({ status: null, compact_result: 'success' }), 'status')).toBe('compaction success');
    expect(systemRecordText(status({ status: null, compact_result: 'failed', compact_error: 'too long' }), 'status')).toBe('compaction failed · too long');
  });

  it('names a new permission mode', () => {
    expect(systemRecordText(status({ status: null, permissionMode: 'auto' }), 'status')).toBe('permission → auto');
  });

  it('flags a held plan-mode resume', () => {
    expect(systemRecordText(status({ status: null, resume_held_for_plan: true }), 'status')).toBe('interrupted plan-mode turn not re-run');
  });
});
