import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TransformComponent, TransformWrapper, type ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import { Scan, Workflow, X, ZoomIn, ZoomOut } from "lucide-react";
import { applyHighlight, nodeIdOf, readFlowchartGraph, type DiagramGraph } from "@/lib/mermaid/svgGraph";
import { viewBoxSize } from "@/lib/diagramExport";
import { BAR, BAR_BUTTON, DiagramToolbar } from "./DiagramToolbar";

interface DiagramOverlayProps {
  svg: string;
  source: string;
  getLightSvg: () => Promise<string>;
  onClose: () => void;
}

/** A pointer that travelled further than this between down and click was a pan. */
const CLICK_SLOP_PX = 4;

/** Fit never enlarges a drawing beyond this. */
const FIT_MAX_SCALE = 2;

/**
 * Top of the viewer: the bottom edge of the app titlebar. The titlebar is
 * z-[200] across the top of every window (and the web client), so a viewer
 * pinned to inset-0 had its header — title, controls, close — underneath it.
 * Starting below it keeps the titlebar usable too, the way the diff viewer
 * leaves the session header in view.
 */
function titlebarBottom(): number {
  return document.querySelector("[data-app-drag-region]")?.getBoundingClientRect().bottom ?? 0;
}

/**
 * Centres the drawing at `scale`, or at the fit scale when omitted. Centring
 * is computed here rather than with the library's centerView, which placed
 * the content off-centre once a transform was already applied. Fit never
 * enlarges past FIT_MAX_SCALE — three boxes filling a 27-inch screen is not
 * "fit". offsetWidth/Height are the untransformed size, so this is stable
 * whatever the current zoom.
 */
function centerAt(
  zoom: ReactZoomPanPinchRef | null,
  host: HTMLElement | null,
  scale?: number,
  animationMs = 200,
): void {
  const wrapper = zoom?.instance.wrapperComponent;
  if (!zoom || !host || !wrapper || host.offsetWidth === 0 || host.offsetHeight === 0) return;
  const s = scale ?? Math.min(
    wrapper.clientWidth / host.offsetWidth,
    wrapper.clientHeight / host.offsetHeight,
    FIT_MAX_SCALE,
  );
  void zoom.setTransform(
    (wrapper.clientWidth - host.offsetWidth * s) / 2,
    (wrapper.clientHeight - host.offsetHeight * s) / 2,
    s,
    animationMs,
  );
}

/**
 * Full-window diagram viewer: pan (drag), zoom (wheel, pinch, buttons), fit,
 * 100%, the export toolbar, Escape to close.
 *
 * Portalled to <body> rather than mounted beside the transcript the way the
 * diff overlay is, so it works wherever markdown renders — sessions, the
 * side chat, Brain notes — without each host wiring it up.
 *
 * Flowcharts also get click-to-highlight: a node, its edges and its
 * neighbours stay lit and the rest dims. The graph is read back out of
 * mermaid's SVG (see svgGraph.ts); when it cannot be, clicks do nothing and
 * the viewer is pan and zoom only.
 */
export const DiagramOverlay: React.FC<DiagramOverlayProps> = ({ svg, source, getLightSvg, onClose }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<ReactZoomPanPinchRef>(null);
  const graphRef = useRef<DiagramGraph | null>(null);
  const selectedRef = useRef<string | null>(null);
  const downAtRef = useRef<{ x: number; y: number } | null>(null);
  const [canHighlight, setCanHighlight] = useState(false);
  // Read once on open: the titlebar's height does not change under a modal.
  const [top] = useState(titlebarBottom);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, [onClose]);

  // Give the drawing its natural size: inline it is squeezed to the column
  // (`width="100%"` + max-width); here zoom does the scaling.
  useLayoutEffect(() => {
    const el = hostRef.current?.querySelector("svg");
    if (!el) return;
    const { width, height } = viewBoxSize(el);
    el.setAttribute("width", String(width));
    el.setAttribute("height", String(height));
    el.style.maxWidth = "none";
    graphRef.current = readFlowchartGraph(el);
    setCanHighlight(graphRef.current !== null);
    // Open fitted, and instantly: an animated transform issued this early was
    // intermittently overridden by the library's own initial transform and
    // the drawing opened at 1× in the corner. (Its onInit callback fired
    // before the ref was attached, so this runs from here instead.)
    const frame = requestAnimationFrame(() => { centerAt(zoomRef.current, hostRef.current, undefined, 0); });
    return () => { cancelAnimationFrame(frame); };
  }, [svg]);

  const fit = () => { centerAt(zoomRef.current, hostRef.current); };

  const onPointerDown = (e: React.PointerEvent) => {
    downAtRef.current = { x: e.clientX, y: e.clientY };
  };

  const onClick = (e: React.MouseEvent) => {
    const down = downAtRef.current;
    downAtRef.current = null;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return;
    const el = hostRef.current?.querySelector("svg");
    const graph = graphRef.current;
    if (!el || !graph) return;
    const node = (e.target as Element).closest("g.node");
    const id = node ? nodeIdOf(el, node) : null;
    selectedRef.current = id !== null && id !== selectedRef.current ? id : null;
    applyHighlight(el, graph, selectedRef.current);
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Diagram"
      className="fixed inset-x-0 bottom-0 z-50 flex flex-col bg-background"
      style={{ top: `${top}px` }}
    >
      <div className="flex flex-none items-center gap-2 border-b px-3 py-2">
        <Workflow className="h-4 w-4 flex-none text-muted-foreground" />
        <span className="text-[13px] font-medium">Diagram</span>
        {canHighlight && (
          <span className="text-[11px] text-muted-foreground">Click a box to highlight its connections</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div role="group" aria-label="Zoom" className={BAR}>
            <button type="button" className={BAR_BUTTON} onClick={() => { void zoomRef.current?.zoomOut(); }} aria-label="Zoom out" title="Zoom out">
              <ZoomOut />
            </button>
            <button type="button" className={BAR_BUTTON} onClick={() => { void zoomRef.current?.zoomIn(); }} aria-label="Zoom in" title="Zoom in">
              <ZoomIn />
            </button>
            <button type="button" className={BAR_BUTTON} onClick={fit} aria-label="Fit to window" title="Fit to window">
              <Scan />
              <span>Fit</span>
            </button>
            <button type="button" className={BAR_BUTTON} onClick={() => { centerAt(zoomRef.current, hostRef.current, 1); }} aria-label="Actual size" title="Actual size">
              <span>100%</span>
            </button>
          </div>
          <DiagramToolbar source={source} getLightSvg={getLightSvg} />
          <button
            type="button"
            aria-label="Close diagram"
            title="Close (Esc)"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div
        data-testid="diagram-canvas"
        className="flex-1 min-h-0 cursor-grab active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onClick={onClick}
      >
        <TransformWrapper
          ref={zoomRef}
          minScale={0.1}
          maxScale={8}
          limitToBounds={false}
          doubleClick={{ disabled: true }}
        >
          <TransformComponent wrapperStyle={{ width: "100%", height: "100%" }}>
            <div
              ref={hostRef}
              className="omnifex-diagram omnifex-diagram-interactive p-6"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </TransformComponent>
        </TransformWrapper>
      </div>
    </div>,
    document.body,
  );
};
