import { describe, it, expect, vi, beforeEach } from 'vitest';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { createModelsService } from '../services/models';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

const mockedQuery = vi.mocked(sdkQuery);

interface FakeQuery {
  supportedModels: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
}

function makeFakeQuery(opts?: {
  models?: unknown[];
  rejectWith?: Error;
  delayMs?: number;
}): FakeQuery {
  const models = opts?.models ?? [
    { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Fast' },
    { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: 'Deep' },
  ];
  const supportedModels = vi.fn().mockImplementation(async () => {
    if (opts?.delayMs) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
    if (opts?.rejectWith) throw opts.rejectWith;
    return models;
  });
  const close = vi.fn();
  return {
    supportedModels,
    close,
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ value: undefined, done: true }),
    }),
  };
}

describe('modelsService.listSupported', () => {
  beforeEach(() => {
    mockedQuery.mockReset();
  });

  it('returns the SDK-reported model list', async () => {
    const fake = makeFakeQuery();
    mockedQuery.mockReturnValue(fake as any);

    const service = createModelsService();
    const result = await service.listSupported('/tmp/claude-config');

    expect(result).toEqual([
      { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Fast' },
      { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: 'Deep' },
    ]);
    expect(fake.supportedModels).toHaveBeenCalledTimes(1);
  });

  it('passes CLAUDE_CONFIG_DIR into the SDK env', async () => {
    const fake = makeFakeQuery();
    mockedQuery.mockReturnValue(fake as any);

    const service = createModelsService();
    await service.listSupported('/Users/test/.claude-work');

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const args = mockedQuery.mock.calls[0][0] as any;
    expect(args.options.env.CLAUDE_CONFIG_DIR).toBe('/Users/test/.claude-work');
  });

  it('closes the ephemeral query after reading models', async () => {
    const fake = makeFakeQuery();
    mockedQuery.mockReturnValue(fake as any);

    const service = createModelsService();
    await service.listSupported('/tmp/claude-config');

    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('closes the query even when supportedModels() rejects', async () => {
    const fake = makeFakeQuery({ rejectWith: new Error('init failed') });
    mockedQuery.mockReturnValue(fake as any);

    const service = createModelsService();
    const result = await service.listSupported('/tmp/claude-config');

    expect(result).toEqual([]);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('returns an empty array on SDK error rather than throwing', async () => {
    const fake = makeFakeQuery({ rejectWith: new Error('boom') });
    mockedQuery.mockReturnValue(fake as any);

    const service = createModelsService();
    await expect(service.listSupported('/tmp/claude-config')).resolves.toEqual([]);
  });

  it('times out and returns empty if supportedModels() hangs', async () => {
    const fake = makeFakeQuery({ delayMs: 10_000 });
    mockedQuery.mockReturnValue(fake as any);

    const service = createModelsService({ timeoutMs: 50 });
    const result = await service.listSupported('/tmp/claude-config');

    expect(result).toEqual([]);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing configDir with a clear error', async () => {
    const service = createModelsService();
    await expect(service.listSupported('')).rejects.toThrow(/configDir/);
    expect(mockedQuery).not.toHaveBeenCalled();
  });
});
