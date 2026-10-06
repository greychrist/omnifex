/**
 * The Projects page's New Project flow, up to the point where it rejoins Open
 * Project: a native save dialog picks the parent folder and the new folder's
 * name in one step, then the folder is created. Returns its path, or null if
 * the user cancelled. The caller then handles it exactly like a folder chosen
 * through Open Project (account resolution, registration, sessions page).
 *
 * Deps are injected so the flow is testable without a window or IPC.
 */
export interface NewProjectDeps {
  showSaveDialog: (options: Record<string, unknown>) => Promise<unknown>;
  getHomeDirectory: () => Promise<string>;
  createDirectory: (directoryPath: string) => Promise<string>;
}

export async function promptForNewProjectFolder(deps: NewProjectDeps): Promise<string | null> {
  const chosen = await deps.showSaveDialog({
    title: 'New Project',
    buttonLabel: 'Create',
    nameFieldLabel: 'Project Name',
    defaultPath: await deps.getHomeDirectory(),
    properties: ['createDirectory'],
  });
  if (typeof chosen !== 'string' || !chosen) return null;
  return deps.createDirectory(chosen);
}
