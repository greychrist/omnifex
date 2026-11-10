import { describe, it, expect, vi } from 'vitest';
import { getHandlerMap } from '../ipc/handlers';

/** The picker's Refresh: `refresh_supported_models` → models.refresh. */
describe('refresh_supported_models handler', () => {
  const models = {
    listSupported: vi.fn(async () => []),
    refresh: vi.fn(async (configDir: string) => [{ value: 'fable', displayName: `Fable 5.2 @ ${configDir}` }]),
  };
  const handlers = getHandlerMap({ models } as never);

  it('accepts camelCase and snake_case params and returns the fresh catalog', async () => {
    await expect(handlers.refresh_supported_models(null, { configDir: '/a' })).resolves.toEqual([
      { value: 'fable', displayName: 'Fable 5.2 @ /a' },
    ]);
    await handlers.refresh_supported_models(null, { config_dir: '/b' });
    expect(models.refresh).toHaveBeenNthCalledWith(1, '/a');
    expect(models.refresh).toHaveBeenNthCalledWith(2, '/b');
    expect(models.listSupported).not.toHaveBeenCalled();
  });

  it('rejects a call without a config dir', async () => {
    await expect(handlers.refresh_supported_models(null, {})).rejects.toThrow(/configDir is required/);
  });

  it('rejects when the models service is not wired', async () => {
    await expect(getHandlerMap({}).refresh_supported_models(null, { configDir: '/a' })).rejects.toThrow(/unavailable/);
  });
});
