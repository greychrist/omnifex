import * as React from "react";
import * as ReactDOM from "react-dom";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface PopoverProps {
  /**
   * The trigger element
   */
  trigger: React.ReactNode;
  /**
   * The content to display in the popover
   */
  content: React.ReactNode;
  /**
   * Whether the popover is open
   */
  open?: boolean;
  /**
   * Callback when the open state changes
   */
  onOpenChange?: (open: boolean) => void;
  /**
   * Optional className for the content
   */
  className?: string;
  /**
   * Alignment of the popover relative to the trigger
   */
  align?: "start" | "center" | "end";
  /**
   * Side of the trigger to display the popover
   */
  side?: "top" | "bottom";
}

/**
 * Popover component for displaying floating content.
 *
 * Content is rendered via `createPortal` into `document.body` so it escapes
 * the trigger's stacking context. Without the portal, a parent with
 * `position: relative` + `z-40` (e.g. the session header) caps the popover
 * at z-40 globally, letting later z-50 siblings (e.g. SubagentBar's
 * expanded rows) paint on top of it. Positioning is done with
 * `position: fixed` against the trigger's `getBoundingClientRect()` so the
 * popover stays anchored on scroll/resize.
 *
 * @example
 * <Popover
 *   trigger={<Button>Click me</Button>}
 *   content={<div>Popover content</div>}
 *   side="top"
 * />
 */
export const Popover: React.FC<PopoverProps> = ({
  trigger,
  content,
  open: controlledOpen,
  onOpenChange,
  className,
  align = "center",
  side = "bottom",
}) => {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = onOpenChange || setInternalOpen;

  const triggerRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [coords, setCoords] = React.useState<{ top: number; left: number } | null>(null);

  // Close on click outside
  React.useEffect(() => {
    if (!open) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        triggerRef.current &&
        contentRef.current &&
        !triggerRef.current.contains(event.target as Node) &&
        !contentRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, setOpen]);

  // Close on escape
  React.useEffect(() => {
    if (!open) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [open, setOpen]);

  // Reposition against the trigger's viewport rect whenever open. Recomputes
  // on scroll/resize so the popover stays anchored when the user scrolls a
  // parent container or resizes the window. We measure after mount and after
  // the content node is in the DOM so its width is known.
  React.useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const compute = () => {
      const trig = triggerRef.current;
      if (!trig) return;
      const r = trig.getBoundingClientRect();
      const cw = contentRef.current?.offsetWidth ?? 0;
      const ch = contentRef.current?.offsetHeight ?? 0;
      const GAP = 8;
      const top = side === "top" ? r.top - ch - GAP : r.bottom + GAP;
      let left: number;
      if (align === "start") left = r.left;
      else if (align === "end") left = r.right - cw;
      else left = r.left + r.width / 2 - cw / 2;
      setCoords({ top, left });
    };
    compute();
    // Recompute once the content has measured its actual size (e.g. fonts
    // loaded, async children). RAF is sufficient — recharts/framer don't
    // grow further after first paint.
    const raf = requestAnimationFrame(compute);
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
    };
  }, [open, side, align]);

  const animationY = side === "top" ? { initial: 10, exit: 10 } : { initial: -10, exit: -10 };

  const portalNode = open && typeof document !== "undefined" && (
    <div
      ref={contentRef}
      style={{
        position: "fixed",
        top: coords?.top ?? -9999,
        left: coords?.left ?? -9999,
        // Hide until first measurement to avoid a one-frame flash at -9999.
        visibility: coords ? "visible" : "hidden",
        zIndex: 100,
      }}
      className="min-w-[200px]"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: animationY.initial }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: animationY.exit }}
        transition={{ duration: 0.15 }}
        className={cn(
          "rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-md",
          className,
        )}
      >
        {content}
      </motion.div>
    </div>
  );

  return (
    <div className="relative inline-block">
      <div ref={triggerRef} onClick={() => setOpen(!open)}>
        {trigger}
      </div>
      {portalNode && ReactDOM.createPortal(portalNode, document.body)}
    </div>
  );
};
