/**
 * Clipboard writes, on the Mac, through the app's bridge.
 *
 * The page first loaded from the daemon's tailnet address over plain http,
 * which WebKit gives no secure context — no `navigator.clipboard`, no
 * `ClipboardItem` — so every copy button threw (0.5.0; Electron never
 * enforced it). The page now loads from loopback and has WebKit's clipboard,
 * but WebKit refuses a write that comes after an `await`, as image copy's
 * does (it encodes a PNG first). The pasteboard has neither rule, so on the
 * desktop the writes always go native; reads stay the page's own.
 *
 * Installed by `bootstrap.ts` on the desktop only, so feature code keeps
 * calling the standard API. The iPad client has no bridge and keeps the
 * browser's behaviour.
 */
import type { NativeBridge } from '@/lib/platform';

type ClipboardData = Blob | string;

interface NativeClipboardEntry {
  type: string;
  text?: string;
  base64?: string;
}

class BridgeClipboardItem {
  readonly types: readonly string[];
  constructor(private readonly items: Record<string, ClipboardData | PromiseLike<ClipboardData>>) {
    this.types = Object.keys(items);
  }
  async getType(type: string): Promise<Blob> {
    const value = await this.items[type];
    if (value === undefined) throw new DOMException(`No ${type} in this item`, 'NotFoundError');
    return typeof value === 'string' ? new Blob([value], { type }) : value;
  }
}

function readAs(blob: Blob, how: 'text' | 'dataUrl'): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // readAsText and readAsDataURL both produce a string.
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('could not read clipboard data'));
    if (how === 'text') reader.readAsText(blob);
    else reader.readAsDataURL(blob);
  });
}

async function toEntry(type: string, blob: Blob): Promise<NativeClipboardEntry> {
  if (type.startsWith('text/')) return { type, text: await readAs(blob, 'text') };
  const dataUrl = await readAs(blob, 'dataUrl');
  return { type, base64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}

export function installNativeClipboard(native: NativeBridge): void {
  const page = navigator.clipboard as Clipboard | undefined;
  const send = async (items: NativeClipboardEntry[]): Promise<void> => {
    await native.invoke('clipboard:write', { items });
  };
  const clipboard = {
    writeText: (text: string) => send([{ type: 'text/plain', text }]),
    write: async (items: readonly ClipboardItem[]) => {
      const entries: NativeClipboardEntry[] = [];
      for (const item of items) {
        for (const type of item.types) entries.push(await toEntry(type, await item.getType(type)));
      }
      await send(entries);
    },
    ...(page ? { readText: () => page.readText(), read: () => page.read() } : {}),
  };
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  if (typeof globalThis.ClipboardItem === 'undefined') {
    Object.defineProperty(globalThis, 'ClipboardItem', { value: BridgeClipboardItem, configurable: true, writable: true });
  }
}
