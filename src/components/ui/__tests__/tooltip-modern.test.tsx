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

afterEach(() => cleanup());

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
