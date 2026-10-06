import { describe, it, expect, vi } from 'vitest';
import { promptForNewProjectFolder } from '../newProject';

function deps(dialogResult: unknown) {
  return {
    showSaveDialog: vi.fn(async () => dialogResult),
    getHomeDirectory: vi.fn(async () => '/Users/me'),
    createDirectory: vi.fn(async (p: string) => p),
  };
}

describe('promptForNewProjectFolder', () => {
  it('asks for a parent folder and name, starting from home', async () => {
    const d = deps(null);
    await promptForNewProjectFolder(d);
    expect(d.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'New Project',
        buttonLabel: 'Create',
        defaultPath: '/Users/me',
      }),
    );
  });

  it('creates the chosen folder and returns its path', async () => {
    const d = deps('/Users/me/Repos/new-thing');
    await expect(promptForNewProjectFolder(d)).resolves.toBe('/Users/me/Repos/new-thing');
    expect(d.createDirectory).toHaveBeenCalledWith('/Users/me/Repos/new-thing');
  });

  it('returns null and creates nothing when the dialog is cancelled', async () => {
    const d = deps(null);
    await expect(promptForNewProjectFolder(d)).resolves.toBeNull();
    expect(d.createDirectory).not.toHaveBeenCalled();
  });

  it('propagates a createDirectory failure (e.g. the path is a file)', async () => {
    const d = deps('/Users/me/existing');
    d.createDirectory.mockRejectedValueOnce(new Error('exists and is not a folder'));
    await expect(promptForNewProjectFolder(d)).rejects.toThrow(/not a folder/);
  });
});
