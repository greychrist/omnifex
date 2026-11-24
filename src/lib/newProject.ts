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
