# Design: Image Download + Message Resend

**Date:** 2026-04-28  
**Status:** Approved

## Overview

Two additive UI features on user message cards in the session chat:

1. **Image download** — hover any inline image in a user message to reveal a download button.
2. **Resend** — each user prompt card gets a resend button (rightmost action, to the right of copy).

No new IPC, no new services, no state changes outside the renderer.

---

## Feature 1: Image Download Button

### Where images are rendered

`src/components/StreamMessage.tsx` has two image render sites in the user message branch:

- **Base64 images** (line 796): `content.type === "image" && content.source?.type === "base64"` — reconstructs a data URL and renders `<img>`.
- **File-path images** (line 764): `@/path/to/file.png` references — renders `<img src="greychrist-file://...">`.

### Change

Wrap each `<img>` in `div.relative.group/img`. Add a `Download` icon button overlay:

```tsx
<div className="relative inline-block group/img">
  <img ... />
  <button
    onClick={() => downloadImage(dataUrl, filename)}
    className="absolute top-1 right-1 p-1 rounded-md bg-background/80 text-muted-foreground hover:text-foreground opacity-0 group-hover/img:opacity-100 transition-opacity z-10"
    title="Download image"
  >
    <Download className="h-3.5 w-3.5" />
  </button>
</div>
```

### Download helper

```ts
function downloadImage(src: string, filename: string) {
  const a = document.createElement('a');
  a.href = src;
  a.download = filename;
  a.click();
}
```

- For base64: `src` is the data URL, `filename` is `image-<timestamp>.<ext>` derived from `media_type`.
- For file paths: `src` is the `greychrist-file://` URL. Electron serves this protocol so the `<a download>` trick works the same way.

---

## Feature 2: Resend Button

### Position

The `CopyCardButton` is currently at `absolute top-1 right-1`. After this change:

- **Copy** moves to `right-8` (shifts 7 units left to make room).
- **Resend** sits at `right-1` — the rightmost action button.

Both appear on `group-hover/card`.

### New prop

```ts
interface StreamMessageProps {
  // ... existing props ...
  onResend?: (text: string, images?: string[]) => void;
}
```

### ResendButton component

```tsx
const ResendButton: React.FC<{ msg: any; onResend: (text: string, images?: string[]) => void }> = ({ msg, onResend }) => {
  const handleResend = (e: React.MouseEvent) => {
    e.stopPropagation();
    const content: any[] = Array.isArray(msg.content) ? msg.content : [];
    const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    const images = content
      .filter(c => c.type === 'image' && c.source?.type === 'base64')
      .map(c => `data:${c.source.media_type};base64,${c.source.data}`);
    onResend(text, images.length > 0 ? images : undefined);
  };

  return (
    <button
      onClick={handleResend}
      className="absolute top-1 right-1 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 opacity-0 group-hover/card:opacity-100 transition-opacity z-10"
      title="Resend message"
    >
      <RotateCcw className="h-3.5 w-3.5" />
    </button>
  );
};
```

### Placement in the user message card

```tsx
<Card className={cn(..., "group/card relative")} ...>
  <CopyCardButton message={msg} />   {/* shifted to right-8 */}
  {onResend && !isToolResultOnly && !isSubagentPrompt && (
    <ResendButton msg={msg} onResend={onResend} />
  )}
  <CardContent ...>
```

Resend is suppressed for:
- Tool-result-only messages (`isToolResultOnly`)
- Subagent-generated prompts (`isSubagentPrompt`)
- SDK bracket messages (already return early before the card)
- Skill injection messages (skill context, not a user prompt)

### Threading from ClaudeCodeSession

`ClaudeCodeSession` renders `StreamMessage` in its message list. Pass:

```tsx
<StreamMessage
  ...
  onResend={(text, images) => handleSendPrompt(text, undefined, images)}
/>
```

`handleSendPrompt` already accepts `(prompt: string, model?: string, images?: string[])`, so no changes needed there.

---

## Files Changed

| File | Change |
|------|--------|
| `src/components/StreamMessage.tsx` | Add `onResend` prop; add `ResendButton`; wrap image renders; shift `CopyCardButton` to `right-8`; import `Download`, `RotateCcw` |
| `src/components/ClaudeCodeSession.tsx` | Pass `onResend` prop when rendering `StreamMessage` |

---

## Testing

Renderer-only change → `npm run check` + `npm run build`. Manually verify:
- Hover a user message with an image → download button appears, click saves file
- Hover any user prompt → resend button appears at right edge, click re-submits text and images
- Resend button absent on tool-result cards and subagent prompt cards
