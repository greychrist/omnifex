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
 * useImageDropZone — sets up native browser drag-drop event listeners on
 * `document` for image file drops (Electron-compatible).
 *
 * Returns `dragActive` for visual feedback and calls `onDrop` with new
 * image paths when the user drops image files.
 */
export function useImageDropZone(
  isExpanded: boolean,
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  expandedTextareaRef: React.RefObject<HTMLTextAreaElement | null>,
  setPrompt: React.Dispatch<React.SetStateAction<string>>,
  extractPaths: (text: string) => string[],
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

    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragActive(false);

      const currentTime = Date.now();
      if (currentTime - lastDropTime < 200) {
        return;
      }
      lastDropTime = currentTime;

      const files = Array.from(e.dataTransfer?.files ?? []);
      const imagePaths = files
        .filter(f => isImageFile(f.name))
        .map(f => (f as any).path as string)
        .filter(Boolean);

      if (imagePaths.length > 0) {
        setPrompt(currentPrompt => {
          const existingPaths = extractPaths(currentPrompt);
          const newPaths = imagePaths.filter((p: string) => !existingPaths.includes(p));

          if (newPaths.length === 0) {
            return currentPrompt;
          }

          const mentionsToAdd = newPaths.map((p: string) => {
            if (p.includes(' ')) {
              return `@"${p}"`;
            }
            return `@${p}`;
          }).join(' ');
          const newPrompt = currentPrompt + (currentPrompt.endsWith(' ') || currentPrompt === '' ? '' : ' ') + mentionsToAdd + ' ';

          setTimeout(() => {
            const target = isExpanded ? expandedTextareaRef.current : textareaRef.current;
            target?.focus();
            target?.setSelectionRange(newPrompt.length, newPrompt.length);
          }, 0);

          return newPrompt;
        });
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
  }, [isExpanded]); // isExpanded needed for ref selection in drop handler

  return { dragActive, setDragActive };
}
