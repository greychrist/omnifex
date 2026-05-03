// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, screen, cleanup } from "@testing-library/react";
import { Popover } from "../popover";

afterEach(() => cleanup());

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
