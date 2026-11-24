/** Desktop writes go native: WebKit refuses a clipboard write that follows an `await` (image copy encodes a PNG first). Reads stay the page's own. */
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
