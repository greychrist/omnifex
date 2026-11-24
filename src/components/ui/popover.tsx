import * as React from "react";
import * as ReactDOM from "react-dom";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { computePopoverPosition } from "./popoverPosition";

// The default `inline-block` wrapper shrink-wraps, so a `flex-1` trigger inside it can't truncate.
export const FIELD_TRIGGER = "relative block w-full min-w-0";

interface PopoverProps {
  trigger: React.ReactNode;
  content: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
  triggerClassName?: string;
}

// Portaled nested popovers register with every ancestor, else the outer click-outside collapses the stack.
interface PopoverNesting {
  registerDescendant: (node: HTMLElement) => () => void;
}
const PopoverNestingContext = React.createContext<PopoverNesting | null>(null);

// Portaled to body: a `relative z-40` ancestor would otherwise cap its z-index.
export const Popover: React.FC<PopoverProps> = ({
  trigger,
  content,
  open: controlledOpen,
  onOpenChange,
  className,
  align = "center",
  side = "bottom",
  triggerClassName = "relative inline-block",
}) => {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = onOpenChange || setInternalOpen;

  const triggerRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [coords, setCoords] = React.useState<{ top: number; left: number } | null>(null);

  const parentNesting = React.useContext(PopoverNestingContext);
  const descendantsRef = React.useRef<Set<HTMLElement>>(new Set());
  const registerDescendant = React.useCallback((node: HTMLElement) => {
    descendantsRef.current.add(node);
    const parentCleanup = parentNesting?.registerDescendant(node);
    return () => {
      descendantsRef.current.delete(node);
      parentCleanup?.();
    };
  }, [parentNesting]);
  const nesting = React.useMemo<PopoverNesting>(() => ({ registerDescendant }), [registerDescendant]);

  React.useEffect(() => {
    if (!open || !parentNesting) return;
    const node = contentRef.current;
    if (!node) return;
    return parentNesting.registerDescendant(node);
  }, [open, parentNesting]);

  React.useEffect(() => {
    if (!open) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const insideDescendant = [...descendantsRef.current].some((n) => n.contains(target));
      if (
        triggerRef.current &&
        contentRef.current &&
        !triggerRef.current.contains(target) &&
        !contentRef.current.contains(target) &&
        !insideDescendant
      ) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => { document.removeEventListener("mousedown", handleClickOutside); };
  }, [open, setOpen]);

  React.useEffect(() => {
    if (!open) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => { document.removeEventListener("keydown", handleEscape); };
  }, [open, setOpen]);

  React.useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const compute = () => {
      const trig = triggerRef.current;
      if (!trig) return;
      setCoords(computePopoverPosition({
        triggerRect: trig.getBoundingClientRect(),
        contentWidth: contentRef.current?.offsetWidth ?? 0,
        contentHeight: contentRef.current?.offsetHeight ?? 0,
        side,
        align,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }));
    };
    compute();
    const raf = requestAnimationFrame(compute);
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);

    // Content can resize without the trigger or window moving; re-clamp when it does.
    const ro = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => { compute(); })
      : null;
    if (ro && contentRef.current) ro.observe(contentRef.current);

    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
    };
  }, [open, side, align]);

  const animationY = side === "top" ? { initial: 10, exit: 10 } : { initial: -10, exit: -10 };

  const portalNode = open && typeof document !== "undefined" && (
    <div
      ref={contentRef}
      // isInsidePopover in ui/dialog.tsx keys on this; without it picking an option closes an enclosing Dialog.
      data-omnifex-popover=""
      style={{
        position: "fixed",
        top: coords?.top ?? -9999,
        left: coords?.left ?? -9999,
        visibility: coords ? "visible" : "hidden",
        // Above the titlebar (z-[200]); tooltips (z-[310]) must stay above this.
        zIndex: 300,
        // A modal Radix Dialog sets body pointer-events:none, and this portal is not a Radix layer.
        pointerEvents: "auto",
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
    <PopoverNestingContext.Provider value={nesting}>
      <div className={triggerClassName}>
        <div ref={triggerRef} onClick={() => { setOpen(!open); }}>
          {trigger}
        </div>
        {portalNode && ReactDOM.createPortal(portalNode, document.body)}
      </div>
    </PopoverNestingContext.Provider>
  );
};
