import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import {
  INVOKE_CHANNELS,
  EVENT_CHANNEL_PREFIXES,
  EVENT_CHANNEL_EXACT,
} from './ipc/channels';

// Allow-lists for IPC channel security. The channel names live in
// ./ipc/channels.ts so a unit test can assert they stay in lockstep with the
// registered handler map (the guardrail against dead/broken channels).
const ALLOWED_INVOKE_CHANNELS = new Set<string>(INVOKE_CHANNELS);
const ALLOWED_EVENT_CHANNELS = new Set<string>(EVENT_CHANNEL_EXACT);

export function addAllowedInvokeChannels(...channels: string[]): void {
  for (const ch of channels) ALLOWED_INVOKE_CHANNELS.add(ch);
}

export function addAllowedEventChannels(...channels: string[]): void {
  for (const ch of channels) ALLOWED_EVENT_CHANNELS.add(ch);
}

function isAllowedEventChannel(channel: string): boolean {
  return (
    ALLOWED_EVENT_CHANNELS.has(channel) ||
    EVENT_CHANNEL_PREFIXES.some((prefix) => channel.startsWith(prefix))
  );
}

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (!ALLOWED_INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, params);
  },

  onEvent: (channel: string, callback: (...args: unknown[]) => void): (() => void) => {
    if (!isAllowedEventChannel(channel)) {
      throw new Error(`Blocked IPC event channel: ${channel}`);
    }
    const listener = (_event: IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  showOpenDialog: (options: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('dialog:open', options),

  showSaveDialog: (options: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('dialog:save', options),

  openExternal: (url: string): Promise<void> => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return Promise.reject(new Error('Unsafe protocol'));
    }
    return ipcRenderer.invoke('shell:openExternal', url);
  },
});
