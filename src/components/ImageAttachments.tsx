import React, { useEffect } from "react";
import { fireAndLog } from "@/lib/fireAndLog";
import { api } from "@/lib/api";
import { planDrop } from "@/lib/fileDrop";

export function isImageFile(path: string): boolean {
  if (path.startsWith('data:image/')) {
    return true;
  }
  const ext = path.split('.').pop()?.toLowerCase();
  return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext || '');
}

export function extractImagePaths(text: string, projectPath?: string): string[] {
  const quotedRegex = /@"([^"]+)"/g;
  const unquotedRegex = /@([^@\n\s]+)/g;
  const pathsSet = new Set<string>();

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

export function removeImageFromPrompt(
  prompt: string,
  embeddedImages: string[],
  index: number,
  projectPath?: string,
): string {
  const imagePath = embeddedImages[index];

  if (imagePath.startsWith('data:')) {
    const quotedPath = `@"${imagePath}"`;
    return prompt.replace(quotedPath, '').trim();
  }

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

async function readFileAsBase64(file: File): Promise<string | null> {
  const dataUrl = await readFileAsDataUrl(file);
  if (!dataUrl) return null;
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : null;
}

interface FileDropZoneOptions {
  /** Every tab is mounted and listens on the document; only the visible one may take a drop. */
  enabled: boolean;
  onImage: (dataUrl: string) => void;
  onMention: (path: string) => void;
}

// WebKit never exposes `File.path`; real paths come from the Mac app's `drop:paths` stash.
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

    // Pin one wrapped fn so removeEventListener matches, or the listener leaks.
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
