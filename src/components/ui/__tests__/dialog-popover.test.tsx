// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { isInsidePopover, POPOVER_MARKER_ATTR } from "../dialog";
import { Popover } from "../popover";

afterEach(() => { cleanup(); });

// Reproduces the "dialog closes when I pick a model/effort/permission option"
// bug. The session-default pickers (FormModelPicker / EffortPicker /
// PermissionPicker) are custom Popovers that portal their content to
// document.body. The Radix Dialog wrapping them (AccountDialog) is a
// DismissableLayer: a pointerdown/focus that lands outside the DialogContent
// DOM subtree dismisses the dialog. Because the popover option is portaled
// OUTSIDE the DialogContent, pressing it reads as an outside interaction and
// collapses the whole dialog before the selection registers.
//
// The full Radix DismissableLayer dismissal can't be driven under jsdom (its
// pointer-outside detection no-ops there), so these tests pin the two real
// contracts of the fix instead of the end-to-end dismissal:
//   1. The popover marks its portaled content so a dialog can recognise it.
//   2. isInsidePopover() — wired into DialogContent.onInteractOutside to call
//      preventDefault() — treats an interaction originating in that content as
//      "inside the dialog", but a genuine outside target as "outside".
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
    // A modal Radix Dialog sets `body { pointer-events: none }` and only its
    // own layer back to `auto`. The popover portals to body and is NOT a Radix
    // layer, so without an explicit override it inherits `none` — clicks fall
    // straight through the option (the "dialog stays open but I can't pick
    // anything" symptom). The portal must re-enable pointer events on itself.
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
