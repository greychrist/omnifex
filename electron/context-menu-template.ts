import type { MenuItemConstructorOptions } from 'electron';

export interface ContextMenuEditFlags {
  canCut?: boolean;
  canCopy?: boolean;
  canPaste?: boolean;
  canSelectAll?: boolean;
}

export interface ContextMenuParams {
  selectionText?: string;
  isEditable?: boolean;
  linkURL?: string;
  editFlags?: ContextMenuEditFlags;
}

export interface ContextMenuActions {
  openLink(url: string): void;
  copyLink(url: string): void;
  lookUpSelection(): void;
}

export interface ContextMenuOptions {
  platform?: NodeJS.Platform;
}

/** macOS truncates the echoed selection rather than growing the menu to fit. */
const LOOK_UP_LABEL_MAX = 24;

export function lookUpLabel(selectionText: string): string {
  const collapsed = selectionText.trim().replace(/\s+/g, ' ');
  const shown =
    collapsed.length > LOOK_UP_LABEL_MAX
      ? `${collapsed.slice(0, LOOK_UP_LABEL_MAX)}…`
      : collapsed;
  return `Look Up “${shown}”`;
}

export function buildContextMenuTemplate(
  params: ContextMenuParams,
  actions: ContextMenuActions,
  options: ContextMenuOptions = {}
): MenuItemConstructorOptions[] {
  const { selectionText, isEditable, linkURL } = params;
  const editFlags = params.editFlags ?? {};
  const platform = options.platform ?? process.platform;
  const hasText = typeof selectionText === 'string' && selectionText.trim().length > 0;
  const template: MenuItemConstructorOptions[] = [];

  if (linkURL) {
    template.push({ label: 'Open Link', click: () => actions.openLink(linkURL) });
    template.push({ label: 'Copy Link', click: () => actions.copyLink(linkURL) });
    template.push({ type: 'separator' });
  }

  // showDefinitionForSelection() is macOS-only; elsewhere the item would be inert.
  if (hasText && platform === 'darwin') {
    template.push({ label: lookUpLabel(selectionText), click: () => actions.lookUpSelection() });
    template.push({ type: 'separator' });
  }

  if (isEditable) {
    template.push({ role: 'cut', enabled: !!editFlags.canCut });
    template.push({ role: 'copy', enabled: !!editFlags.canCopy });
    template.push({ role: 'paste', enabled: !!editFlags.canPaste });
    template.push({ type: 'separator' });
    template.push({ role: 'selectAll', enabled: !!editFlags.canSelectAll });
  } else if (hasText) {
    template.push({ role: 'copy' });
    template.push({ type: 'separator' });
    template.push({ role: 'selectAll' });
  } else {
    template.push({ role: 'selectAll' });
  }

  return template;
}
