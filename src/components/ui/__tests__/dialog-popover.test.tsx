// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { isInsidePopover, POPOVER_MARKER_ATTR } from "../dialog";
import { Popover } from "../popover";

afterEach(() => { cleanup(); });

// The pickers' Popovers portal to body, outside the Dialog's DismissableLayer,
// so a press on an option reads as outside the dialog.
describe("popover-aware dialog dismissal", () => {
  it("marks the popover's portaled content with the dialog-recognised attribute", () => {
    render(
      <Popover
        open
        trigger={<button>t</button>}
        content={<button>option-a</button>}
      />,
    );
    const option = screen.getByText("option-a");
    expect(option.closest(`[${POPOVER_MARKER_ATTR}]`)).not.toBeNull();
  });

  it("treats a target inside a popover as inside the dialog (no dismiss)", () => {
    render(
      <Popover
        open
        trigger={<button>t</button>}
        content={<button>option-a</button>}
      />,
    );
    expect(isInsidePopover(screen.getByText("option-a"))).toBe(true);
  });

  it("keeps the popover content interactive when a modal layer disables body pointer events", () => {
    // A modal Radix Dialog sets `body { pointer-events: none }`; the popover
    // portals to body, so it must re-enable pointer events on itself.
    render(
      <Popover
        open
        trigger={<button>t</button>}
        content={<button>option-a</button>}
      />,
    );
    const marked = screen
      .getByText("option-a")
      .closest(`[${POPOVER_MARKER_ATTR}]`) as HTMLElement;
    expect(marked.style.pointerEvents).toBe("auto");
  });

  it("treats a genuine outside target as outside (still dismisses)", () => {
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    expect(isInsidePopover(outside)).toBe(false);
    outside.remove();
  });

  it("is null-safe", () => {
    expect(isInsidePopover(null)).toBe(false);
  });
});
