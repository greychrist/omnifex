import React, { useEffect } from "react";
import { fireAndLog } from "@/lib/fireAndLog";
import { api } from "@/lib/api";
import { planDrop } from "@/lib/fileDrop";

// ── Image utilities ─────────────────────────────────────────────────────

/** Check if a file path (or data URL) refers to an image. */
export function isImageFile(path: string): boolean {
  if (path.startsWith('data:image/')) {
    return true;
  }
  const ext = path.split('.').pop()?.toLowerCase();
  return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext || '');
}

/** Extract image paths from prompt text (both @quoted and @unquoted mentions). */
export function extractImagePaths(text: string, projectPath?: string): string[] {
  const quotedRegex = /@"([^"]+)"/g;
  const unquotedRegex = /@([^@\n\s]+)/g;
  const pathsSet = new Set<string>();

  // Quoted paths (including data URLs)
  let matches = Array.from(text.matchAll(quotedRegex));
  for (const match of matches) {
    const path = match[1];
    const fullPath = path.startsWith('data:')
      ? path
      : (path.startsWith('/') ? path : (projectPath ? `${projectPath}/${path}` : path));
    if (isImageFile(fullPath)) {
      pathsSet.add(fullPath);
    }
  }

  // Unquoted paths
  const textWithoutQuoted = text.replace(quotedRegex, '');
  matches = Array.from(textWithoutQuoted.matchAll(unquotedRegex));
  for (const match of matches) {
    const path = match[1].trim();
    if (path.includes('data:')) continue;
    const fullPath = path.startsWith('/') ? path : (projectPath ? `${projectPath}/${path}` : path);
    if (isImageFile(fullPath)) {
      pathsSet.add(fullPath);
    }
  }

  return Array.from(pathsSet);
}

// ── Paste handler ───────────────────────────────────────────────────────

/** Handle clipboard paste — extracts image blobs and converts to data URLs. */
export function handleImagePaste(
  e: React.ClipboardEvent,
  onImagePasted: (dataUrl: string) => void,
): void {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();

      const blob = item.getAsFile();
      if (!blob) continue;

      try {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          onImagePasted(dataUrl);
        };
        reader.readAsDataURL(blob);
      } catch (error) {
        console.error('Failed to paste image:', error);
      }
    }
  }
}

// ── Remove handler ──────────────────────────────────────────────────────

/** Build a handler that removes an @-mentioned image path from the prompt. */
export function removeImageFromPrompt(
  prompt: string,
  embeddedImages: string[],
  index: number,
  projectPath?: string,
): string {
  const imagePath = embeddedImages[index];

  // For data URLs, they're always quoted
  if (imagePath.startsWith('data:')) {
    const quotedPath = `@"${imagePath}"`;
    return prompt.replace(quotedPath, '').trim();
  }

  // For file paths, use regex to strip the @mention
  const escapedPath = imagePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedRelativePath = imagePath.replace((projectPath ?? '') + '/', '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const patterns = [
    new RegExp(`@"${escapedPath}"\\s?`, 'g'),
    new RegExp(`@${escapedPath}\\s?`, 'g'),
    new RegExp(`@"${escapedRelativePath}"\\s?`, 'g'),
    new RegExp(`@${escapedRelativePath}\\s?`, 'g'),
  ];

  let newPrompt = prompt;
  for (const pattern of patterns) {
    newPrompt = newPrompt.replace(pattern, '');
  }

  return newPrompt.trim();
}

// ── Drop zone hook ──────────────────────────────────────────────────────

/**
 * Read a File as a data URL. Returns null if the file can't be read.
 */
function readFileAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => { resolve(reader.result as string); };
      reader.onerror = () => { resolve(null); };
      reader.readAsDataURL(file);
    } catch {
      resolve(null);
    }
  });
}

/** A File's bytes as base64, for `save_dropped_file`. Null if unreadable
 *  (a folder dragged in from a browser has no bytes). */
async function readFileAsBase64(file: File): Promise<string | null> {
  const dataUrl = await readFileAsDataUrl(file);
  if (!dataUrl) return null;
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : null;
}

interface FileDropZoneOptions {
  /** Only the tab on screen takes a drop. Every tab is mounted at once and
   *  each listens on the document, so without this one drop attached to
   *  every open session. */
  enabled: boolean;
  /** An image Claude takes inline, as a data URL (same shape as a paste). */
  onImage: (dataUrl: string) => void;
  /** A path for the prompt to @-mention: the file itself, or its copy. */
  onMention: (path: string) => void;
}

/**
 * useFileDropZone — document-level drag-drop for the chat. What each dropped
 * file becomes is `planDrop`'s call (src/lib/fileDrop.ts): inline image, a
 * mention of the real path the Mac app reports over `drop:paths`, or a
 * mention of a copy the daemon saves when there is no path.
 *
 * `File.path` is not an option: WebKit, like Electron since v32, never
 * exposes where a dropped file lives — hence the native stash.
 */
export function useFileDropZone(
  { enabled, onImage, onMention }: FileDropZoneOptions,
): { dragActive: boolean; setDragActive: React.Dispatch<React.SetStateAction<boolean>> } {
  const [dragActive, setDragActive] = React.useState(false);

  useEffect(() => {
    if (!enabled) {
      setDragActive(false);
      return;
    }
    let lastDropTime = 0;

    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      setDragActive(true);
    };

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      setDragActive(true);
    };

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      setDragActive(false);
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      setDragActive(false);

      const currentTime = Date.now();
      if (currentTime - lastDropTime < 200) return;
      lastDropTime = currentTime;

      const files = Array.from(e.dataTransfer?.files ?? []);
      // Asked even for zero files: a dropped folder can arrive as a path alone.
      const nativePaths = await api.dropPaths().catch(() => [] as string[]);
      if (files.length === 0 && nativePaths.length === 0) return;

      for (const action of planDrop(files, nativePaths)) {
        if (action.kind === 'mention') {
          onMention(action.path);
        } else if (action.kind === 'image') {
          const dataUrl = await readFileAsDataUrl(action.file);
          if (dataUrl) onImage(dataUrl);
        } else {
          const data = await readFileAsBase64(action.file);
          if (data === null) continue;
          onMention(await api.saveDroppedFile(action.file.name, data));
        }
      }
    };

    // handleDrop is async; wrap once via fireAndLog and pin the reference
    // so add/removeEventListener see the same fn (otherwise the
    // remove-pair never fires and the listener leaks).
    const wrappedDrop = fireAndLog('file-drop:drop', handleDrop);
    document.addEventListener('dragenter', handleDragEnter);
    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('drop', wrappedDrop);

    return () => {
      document.removeEventListener('dragenter', handleDragEnter);
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('dragleave', handleDragLeave);
      document.removeEventListener('drop', wrappedDrop);
    };
  }, [enabled, onImage, onMention]);

  return { dragActive, setDragActive };
}
