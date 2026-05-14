import React, { useEffect } from "react";

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

/**
 * useImageDropZone — sets up document-level drag-drop listeners for
 * dropped image files. Dropped images are converted to base64 data URLs
 * via FileReader and passed to `onImageDropped` (same shape as paste).
 *
 * We intentionally do NOT use `File.path` — Electron removed that property
 * in v32+ for security, so the old path-based approach silently dropped
 * every dragged image. Data URLs work for files dragged from Finder,
 * browsers, screenshot tools, Slack, etc.
 */
export function useImageDropZone(
  onImageDropped: (dataUrl: string) => void,
): { dragActive: boolean; setDragActive: React.Dispatch<React.SetStateAction<boolean>> } {
  const [dragActive, setDragActive] = React.useState(false);

  useEffect(() => {
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

      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
        f.type.startsWith('image/') || isImageFile(f.name),
      );
      if (files.length === 0) return;

      for (const file of files) {
        const dataUrl = await readFileAsDataUrl(file);
        if (dataUrl) onImageDropped(dataUrl);
      }
    };

    document.addEventListener('dragenter', handleDragEnter);
    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('drop', handleDrop);

    return () => {
      document.removeEventListener('dragenter', handleDragEnter);
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('dragleave', handleDragLeave);
      document.removeEventListener('drop', handleDrop);
    };
  }, [onImageDropped]);

  return { dragActive, setDragActive };
}
