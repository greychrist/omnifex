import { describe, it, expect, vi } from 'vitest';
import { getHandlerMap } from '../ipc/handlers';

/**
 * The `create_directory` hop between the renderer and filesystem.ts: param
 * normalisation and the missing-service error. The service's own tests call
 * it directly, so nothing else exercises this layer.
 */
describe('create_directory handler', () => {
  const filesystem = { createDirectory: vi.fn(async (p: string) => p) };
  const handlers = getHandlerMap({ filesystem } as never);

  it('accepts camelCase and snake_case params', async () => {
    await expect(handlers.create_directory(null, { directoryPath: '/a' })).resolves.toBe('/a');
    await expect(handlers.create_directory(null, { directory_path: '/b' })).resolves.toBe('/b');
    expect(filesystem.createDirectory).toHaveBeenNthCalledWith(1, '/a');
    expect(filesystem.createDirectory).toHaveBeenNthCalledWith(2, '/b');
  });

  it('rejects a call without a path', async () => {
    await expect(handlers.create_directory(null, {})).rejects.toThrow(/directoryPath is required/);
  });

  it('rejects when the filesystem service is not wired, rather than returning null', async () => {
    await expect(getHandlerMap({}).create_directory(null, { directoryPath: '/a' })).rejects.toThrow(/unavailable/);
  });
});

describe('save_dropped_file handler', () => {
  const filesystem = { saveDroppedFile: vi.fn(async (name: string) => `/drop/${name}`) };
  const handlers = getHandlerMap({ filesystem } as never);

  it('passes name and base64 data through and returns the saved path', async () => {
    await expect(handlers.save_dropped_file(null, { name: 'a.pdf', data: 'eA==' })).resolves.toBe('/drop/a.pdf');
    expect(filesystem.saveDroppedFile).toHaveBeenCalledWith('a.pdf', 'eA==');
  });

  it('rejects a call missing the name or the data', async () => {
    await expect(handlers.save_dropped_file(null, { data: 'eA==' })).rejects.toThrow(/name is required/);
    await expect(handlers.save_dropped_file(null, { name: 'a' })).rejects.toThrow(/data is required/);
  });

  it('rejects when the filesystem service is not wired', async () => {
    await expect(getHandlerMap({}).save_dropped_file(null, { name: 'a', data: 'eA==' })).rejects.toThrow(/unavailable/);
  });
});
