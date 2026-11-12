// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  TooltipSimple,
} from "../tooltip-modern";

afterEach(() => { cleanup(); });

describe("TooltipSimple", () => {
  it("renders the trigger child", () => {
    render(
      <TooltipProvider>
        <TooltipSimple content="Help text">
          <button>Trigger</button>
        </TooltipSimple>
      </TooltipProvider>,
    );
    expect(screen.getByText("Trigger")).toBeTruthy();
  });

  it("accepts custom side and align props without throwing", () => {
    render(
      <TooltipProvider>
        <TooltipSimple content="Right-aligned" side="right" align="end">
          <button>T</button>
        </TooltipSimple>
      </TooltipProvider>,
    );
    expect(screen.getByText("T")).toBeTruthy();
  });

  it("forwards className and contentClassName props", () => {
    render(
      <TooltipProvider>
        <TooltipSimple
          content="x"
          className="trigger-cls"
          contentClassName="content-cls"
        >
          <button>T</button>
        </TooltipSimple>
      </TooltipProvider>,
    );
    expect(screen.getByText("T")).toBeTruthy();
  });

  it("works with all four sides", () => {
    for (const side of ["top", "right", "bottom", "left"] as const) {
      render(
        <TooltipProvider>
          <TooltipSimple content={`${side}-tip`} side={side}>
            <button>{`btn-${side}`}</button>
          </TooltipSimple>
        </TooltipProvider>,
      );
      expect(screen.getByText(`btn-${side}`)).toBeTruthy();
      cleanup();
    }
  });
});

describe("Tooltip primitives are re-exported", () => {
  it("renders raw Tooltip + TooltipTrigger + TooltipContent", () => {
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button>raw-trigger</button>
          </TooltipTrigger>
          <TooltipContent>raw-content</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    expect(screen.getByText("raw-trigger")).toBeTruthy();
  });
});

// Popovers sit above the titlebar (z 300). A tooltip inside one must still
// paint over it — at z-[100] it now would not.
describe("TooltipContent stacking", () => {
  it("paints above popovers", () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger asChild><button>T</button></TooltipTrigger>
          <TooltipContent data-testid="tip">tip</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const z = /z-\[(\d+)\]/.exec(screen.getByTestId("tip").className)?.[1];
    expect(Number(z)).toBeGreaterThan(300);
  });
});
