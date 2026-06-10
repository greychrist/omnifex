// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, screen, cleanup } from "@testing-library/react";
import { Popover } from "../popover";

afterEach(() => { cleanup(); });

describe("Popover (uncontrolled)", () => {
  it("renders only the trigger when closed", () => {
    render(<Popover trigger={<button>open</button>} content={<div>body</div>} />);
    expect(screen.queryByText("open")).toBeTruthy();
    expect(screen.queryByText("body")).toBeNull();
  });

  it("opens content when trigger is clicked", () => {
    render(<Popover trigger={<button>open</button>} content={<div>body</div>} />);
    fireEvent.click(screen.getByText("open"));
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("toggles closed when trigger is clicked again", () => {
    render(<Popover trigger={<button>open</button>} content={<div>body</div>} />);
    fireEvent.click(screen.getByText("open"));
    fireEvent.click(screen.getByText("open"));
    expect(screen.queryByText("body")).toBeNull();
  });

  it("closes on outside click", () => {
    render(
      <div>
        <Popover trigger={<button>open</button>} content={<div>body</div>} />
        <span data-testid="outside">outside</span>
      </div>,
    );
    fireEvent.click(screen.getByText("open"));
    expect(screen.getByText("body")).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByText("body")).toBeNull();
  });

  it("does not close when clicking inside the content", () => {
    render(
      <Popover
        trigger={<button>open</button>}
        content={<button>inner</button>}
      />,
    );
    fireEvent.click(screen.getByText("open"));
    fireEvent.mouseDown(screen.getByText("inner"));
    expect(screen.getByText("inner")).toBeTruthy();
  });

  it("closes on Escape key", () => {
    render(<Popover trigger={<button>open</button>} content={<div>body</div>} />);
    fireEvent.click(screen.getByText("open"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("body")).toBeNull();
  });

  it("ignores non-Escape keys", () => {
    render(<Popover trigger={<button>open</button>} content={<div>body</div>} />);
    fireEvent.click(screen.getByText("open"));
    fireEvent.keyDown(document, { key: "Enter" });
    expect(screen.getByText("body")).toBeTruthy();
  });
});

describe("Popover (controlled)", () => {
  it("respects controlled open=true", () => {
    render(
      <Popover open trigger={<button>open</button>} content={<div>body</div>} />,
    );
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("respects controlled open=false", () => {
    render(
      <Popover open={false} trigger={<button>open</button>} content={<div>body</div>} />,
    );
    expect(screen.queryByText("body")).toBeNull();
  });

  it("calls onOpenChange when trigger is clicked", () => {
    const onOpenChange = vi.fn();
    render(
      <Popover
        open={false}
        onOpenChange={onOpenChange}
        trigger={<button>open</button>}
        content={<div>body</div>}
      />,
    );
    fireEvent.click(screen.getByText("open"));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});

describe("Popover portal rendering", () => {
  // The popover renders into a portal at document.body so it escapes the
  // trigger's stacking context. Without the portal, a parent with
  // `position: relative` + `z-40` (e.g. the session header) caps the popover
  // at z-40 globally, letting later z-50 siblings (e.g. SubagentBar's
  // expanded rows) paint on top of it.
  it("renders open content as a child of document.body, not the trigger's parent", () => {
    render(
      <div data-testid="trigger-wrapper" style={{ position: "relative", zIndex: 1 }}>
        <Popover
          open
          trigger={<button>t</button>}
          content={<div data-testid="popover-body">body</div>}
        />
      </div>,
    );
    const body = screen.getByTestId("popover-body");
    const wrapper = screen.getByTestId("trigger-wrapper");
    // Walk up from the popover body — it must reach document.body without
    // passing through the trigger's wrapper.
    let el: HTMLElement | null = body;
    let passedThroughWrapper = false;
    while (el && el !== document.body) {
      if (el === wrapper) {
        passedThroughWrapper = true;
        break;
      }
      el = el.parentElement;
    }
    expect(passedThroughWrapper).toBe(false);
    expect(el).toBe(document.body);
  });

  it("still renders the trigger inline (only the content is portaled)", () => {
    render(<Popover open trigger={<button>t</button>} content={<div>body</div>} />);
    const trigger = screen.getByText("t");
    // Trigger walks back to document.body through the rendered tree as
    // normal (it's not portaled).
    expect(trigger.closest("body")).toBe(document.body);
  });
});

// Reproduces the nested-portal close bug: an inner Popover lives inside an
// outer Popover's content. Both portal their content to document.body as
// SEPARATE subtrees, so a press inside the inner popover is, by raw DOM
// containment, "outside" the outer popover's content node. Without the
// nesting registry, the outer popover's mousedown click-outside handler
// closes the whole stack the moment you press an inner option (the symptom:
// "I click a model/effort/permission option and the popover just closes").
describe("Popover nested-portal click handling", () => {
  function Nested({ onSelect }: { onSelect?: () => void }) {
    const [outerOpen, setOuterOpen] = useState(true);
    const [innerOpen, setInnerOpen] = useState(false);
    return (
      <Popover
        open={outerOpen}
        onOpenChange={setOuterOpen}
        trigger={<button>outer-trigger</button>}
        content={
          <div>
            <span>outer-content</span>
            <Popover
              open={innerOpen}
              onOpenChange={setInnerOpen}
              trigger={<button>inner-trigger</button>}
              content={<button onClick={() => { onSelect?.(); }}>inner-option</button>}
            />
          </div>
        }
      />
    );
  }

  it("keeps the outer popover open when an inner popover option is pressed", () => {
    let selected = false;
    render(<Nested onSelect={() => { selected = true; }} />);

    fireEvent.click(screen.getByText("inner-trigger"));
    expect(screen.getByText("inner-option")).toBeTruthy();

    // mousedown is what the click-outside handler listens on. Pressing the
    // inner option must not be treated as a click outside the outer popover.
    const option = screen.getByText("inner-option");
    fireEvent.mouseDown(option);
    fireEvent.click(option);

    expect(screen.getByText("outer-content")).toBeTruthy();
    expect(selected).toBe(true);
  });

  it("still closes the outer popover on a genuine outside press", () => {
    render(<Nested />);
    expect(screen.getByText("outer-content")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("outer-content")).toBeNull();
  });
});

describe("Popover side and align variants", () => {
  it("renders with side='top'", () => {
    render(
      <Popover open side="top" trigger={<button>t</button>} content={<div>body</div>} />,
    );
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("renders with align='start'", () => {
    render(
      <Popover open align="start" trigger={<button>t</button>} content={<div>body</div>} />,
    );
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("renders with align='end'", () => {
    render(
      <Popover open align="end" trigger={<button>t</button>} content={<div>body</div>} />,
    );
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("applies custom className to content", () => {
    render(
      <Popover
        open
        className="my-popover-class"
        trigger={<button>t</button>}
        content={<div>body</div>}
      />,
    );
    const body = screen.getByText("body");
    // Walk up to find the className
    let el: HTMLElement | null = body;
    let foundClass = false;
    while (el) {
      if (el.className && typeof el.className === "string" && el.className.includes("my-popover-class")) {
        foundClass = true;
        break;
      }
      el = el.parentElement;
    }
    expect(foundClass).toBe(true);
  });
});
