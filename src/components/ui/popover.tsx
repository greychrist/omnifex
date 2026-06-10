import * as React from "react";
import * as ReactDOM from "react-dom";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { computePopoverPosition } from "./popoverPosition";

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
  /**
   * Optional override for the outer wrapper around the trigger. Defaults to
   * "relative inline-block" — pass "relative block w-full" to make the
   * trigger occupy a full row (e.g. so a form-field trigger sits below its
   * label instead of beside it).
   */
  triggerClassName?: string;
}

/**
 * Lets a nested Popover register its portaled content node with every
 * ancestor Popover. Because each popover portals its content to
 * `document.body` as a separate subtree, an inner popover's content is —
 * by raw DOM containment — "outside" the outer popover's content node. Left
 * unhandled, the outer popover's click-outside handler fires the instant you
 * press an option in the inner popover, collapsing the whole stack (the
 * "click an option and the popover just closes" bug). Each Popover provides
 * this context to its children and, when open, registers its own content
 * node with its parent; registrations bubble up so arbitrary nesting depth
 * is covered.
 */
interface PopoverNesting {
  /** Register a node as belonging to this popover layer (and all ancestors).
   *  Returns a cleanup that unregisters it. */
  registerDescendant: (node: HTMLElement) => () => void;
}
const PopoverNestingContext = React.createContext<PopoverNesting | null>(null);

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
  triggerClassName = "relative inline-block",
}) => {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = onOpenChange || setInternalOpen;

  const triggerRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const [coords, setCoords] = React.useState<{ top: number; left: number } | null>(null);

  // Nested-popover registry. `descendants` holds the portaled content nodes
  // of child popovers (and their children) so click-outside can treat a press
  // inside any descendant popover as "inside" this one.
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

  // While open, register our own content node with every ancestor popover so
  // their click-outside handlers don't treat a press inside us as "outside".
  React.useEffect(() => {
    if (!open || !parentNesting) return;
    const node = contentRef.current;
    if (!node) return;
    return parentNesting.registerDescendant(node);
  }, [open, parentNesting]);

  // Close on click outside
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

  // Close on escape
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
      // computePopoverPosition clamps into the viewport so panels anchored
      // near an edge never render off-screen (see popoverPosition.tsx).
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
      // Lets an ancestor Radix DismissableLayer (e.g. a Dialog) recognise a
      // press inside this portaled content as "inside" and skip dismissing —
      // see isInsidePopover in ui/dialog.tsx. Without it, a popover embedded
      // in a dialog (the account editor's model/effort/permission pickers)
      // closes the whole dialog the moment you pick an option.
      data-omnifex-popover=""
      style={{
        position: "fixed",
        top: coords?.top ?? -9999,
        left: coords?.left ?? -9999,
        // Hide until first measurement to avoid a one-frame flash at -9999.
        visibility: coords ? "visible" : "hidden",
        zIndex: 100,
        // A modal Radix Dialog sets `body { pointer-events: none }` and only
        // re-enables its own layer. This content portals to body and isn't a
        // Radix layer, so it would inherit `none` and swallow every click —
        // the dialog stays open but options can't be selected. Re-enable
        // pointer events for our own subtree. Outside a modal this is the
        // default, so it's a no-op there.
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
