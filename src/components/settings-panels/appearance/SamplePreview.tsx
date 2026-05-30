import React, { useMemo } from "react";
import { withResolvedKindStyle, type KindStyle } from "@/lib/messageRenderingConfig";
import {
  useMessageRenderingConfig,
  MessageRenderingPreviewProvider,
} from "@/contexts/MessageRenderingContext";
import { MessageFrame } from "@/components/StreamMessage/MessageFrame";
import { contentClassNames, typographyFontFamily } from "@/lib/typographyClasses";
import { cn } from "@/lib/utils";
import type { JsonlNode } from "@/types/jsonl";

interface SamplePreviewProps {
  /** The fully-resolved style to preview — a category style or an in-progress
   *  override edit. */
  style: KindStyle;
  /** Kind id (override) or category name. Injected as a sentinel override into
   *  a synthesized config so the real renderer resolves exactly `style`, even
   *  for a category or an edit not yet persisted under this id. */
  kindId: string;
  /** Body text to render in the message. */
  text: string;
}

// Fixed sample receivedAt so every preview card shows a stable timestamp
// footer, matching the live renderer's CardTimestamp.
const PREVIEW_RECEIVED_AT = "2026-04-29T12:34:56";

/**
 * Live preview of a single message kind, rendered through the real
 * `MessageFrame` — the same card / side-line / collapsible shells (and
 * `KindHeader`) the transcript uses — so the editor preview is pixel-identical
 * to a rendered message.
 *
 * `style` may be a category style or an in-progress override edit that isn't
 * persisted yet, so we render against a synthesized config whose category base
 * for `kindId` IS `style` and whose override rules are stripped. The cascade
 * then returns exactly `style` regardless of the kind's category origin.
 */
export const SamplePreview: React.FC<SamplePreviewProps> = ({ style, kindId, text }) => {
  const { config } = useMessageRenderingConfig();

  const previewConfig = useMemo(
    () => withResolvedKindStyle({ ...config, overrides: [] }, kindId, style),
    [config, kindId, style],
  );

  const message = useMemo(
    () => ({ receivedAt: PREVIEW_RECEIVED_AT }) as unknown as JsonlNode,
    [],
  );

  // Side-line bodies render inline (inside a <span>), so pass raw text there;
  // card / collapsible bodies get the configured content typography.
  const body =
    style.presentation === "side-line" ? (
      text
    ) : (
      <div
        className={cn(contentClassNames(config), "whitespace-pre-wrap leading-relaxed text-foreground/90")}
        style={{ fontFamily: typographyFontFamily(config.typography.content) }}
      >
        {text}
      </div>
    );

  return (
    <MessageRenderingPreviewProvider config={previewConfig}>
      <MessageFrame streamKind={kindId} message={message}>
        {body}
      </MessageFrame>
    </MessageRenderingPreviewProvider>
  );
};
