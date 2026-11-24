import React, { useEffect, useRef, useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { fireAndLog } from "@/lib/fireAndLog";

export const DownloadableImage: React.FC<{
  src: string;
  alt: string;
  mediaType?: string;
  className?: string;
}> = ({ src, alt, mediaType, className }) => {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    const ext = mediaType
      ? (mediaType.split('/')[1] ?? 'png').replace('jpeg', 'jpg')
      : src.split('.').pop()?.split('?')[0] ?? 'png';
    const filename = `image-${Date.now()}.${ext}`;
    const a = document.createElement('a');
    a.href = src;
    a.download = filename;
    a.click();
  };

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const response = await fetch(src);
      const blob = await response.blob();
      // Chromium's clipboard rejects most non-PNG blobs, so re-encode.
      let clipboardBlob = blob;
      if (blob.type !== 'image/png') {
        clipboardBlob = await encodeBlobAsPng(blob);
      }
      await navigator.clipboard.write([
        new ClipboardItem({ [clipboardBlob.type]: clipboardBlob }),
      ]);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 1500);
    } catch (err) {
      console.error('Copy image to clipboard failed:', err);
    }
  };

  return (
    <>
      <div className="relative inline-block group/img">
        <img
          src={src}
          alt={alt}
          className={cn(className, 'cursor-zoom-in')}
          onClick={() => { setLightboxOpen(true); }}
        />
        <div
          className="absolute top-1 right-1 inline-flex items-center rounded-md border border-border bg-background/90 overflow-hidden opacity-0 group-hover/img:opacity-100 focus-within:opacity-100 transition-opacity z-10"
          role="toolbar"
          aria-label="Image actions"
        >
          <button
            onClick={fireAndLog('downloadable-image:copy', handleCopy)}
            className="inline-flex items-center justify-center h-6 w-6 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            title={copied ? 'Copied!' : 'Copy image to clipboard'}
            aria-label="Copy image to clipboard"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          <span className="h-4 w-px bg-border" aria-hidden />
          <button
            onClick={handleDownload}
            className="inline-flex items-center justify-center h-6 w-6 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            title="Download image"
            aria-label="Download image"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
        {/* Sized explicitly, not `w-fit`: fit-content on a left-50% fixed element resolves to half the viewport. */}
        <DialogContent className="w-[90vw] h-[90vh] max-w-none flex items-center justify-center p-0 bg-transparent border-0 shadow-none">
          <DialogTitle className="sr-only">{alt || 'Image preview'}</DialogTitle>
          <img
            src={src}
            alt={alt}
            className="max-w-full max-h-full object-contain rounded-md"
          />
        </DialogContent>
      </Dialog>
    </>
  );
};

async function encodeBlobAsPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((out) => {
        if (out) resolve(out);
        else reject(new Error('canvas.toBlob returned null'));
      }, 'image/png');
    });
  } finally {
    bitmap.close();
  }
}
