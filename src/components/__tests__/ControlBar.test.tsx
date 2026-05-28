// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  EffortPicker,
  PermissionPicker,
  normalizePermissionMode,
} from "../ControlBar";
import { TooltipProvider } from "../ui/tooltip-modern";

afterEach(() => { cleanup(); });

function renderInProvider(node: React.ReactNode) {
  return render(<TooltipProvider>{node}</TooltipProvider>);
}

describe("normalizePermissionMode", () => {
  it("translates 'skip' to 'bypassPermissions'", () => {
    expect(normalizePermissionMode("skip")).toBe("bypassPermissions");
  });

  it("passes through other values unchanged", () => {
    for (const m of ["default", "acceptEdits", "plan", "dontAsk", "auto", "bypassPermissions"]) {
      expect(normalizePermissionMode(m)).toBe(m);
    }
  });
});

describe("static option lists", () => {
  it("EFFORT_LEVELS exposes the five SDK effort levels", () => {
    expect(EFFORT_LEVELS.map((e) => e.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("PERMISSION_MODES exposes all six permission modes", () => {
    expect(PERMISSION_MODES.map((m) => m.id)).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "dontAsk",
      "auto",
      "bypassPermissions",
    ]);
  });
});

// ─── EffortPicker ────────────────────────────────────────────────────────

describe("EffortPicker (compact)", () => {
  it("renders the current effort short name", () => {
    renderInProvider(
      <EffortPicker
        effort="high"
        open={false}
        onOpenChange={vi.fn()}
      />,
    );
    // "Hi" is high's shortName
    expect(screen.getAllByText("Hi").length).toBeGreaterThan(0);
  });

  it("calls onOpenChange when trigger button is clicked", () => {
    const onOpenChange = vi.fn();
    renderInProvider(
      <EffortPicker effort="high" open={false} onOpenChange={onOpenChange} />,
    );
    const trigger = screen.getAllByRole("button")[0];
    fireEvent.click(trigger);
    expect(onOpenChange).toHaveBeenCalled();
  });

  it("opens dropdown and lists all five effort levels when open=true", () => {
    renderInProvider(
      <EffortPicker effort="high" open={true} onOpenChange={vi.fn()} />,
    );
    for (const level of EFFORT_LEVELS) {
      // "Max" appears as both shortName and name; use getAllByText
      expect(screen.getAllByText(level.name).length).toBeGreaterThan(0);
    }
  });

  it("calls onEffortChange and closes when a level is picked", () => {
    const onEffortChange = vi.fn();
    const onOpenChange = vi.fn();
    renderInProvider(
      <EffortPicker
        effort="high"
        open={true}
        onEffortChange={onEffortChange}
        onOpenChange={onOpenChange}
      />,
    );
    fireEvent.click(screen.getByText("Low"));
    expect(onEffortChange).toHaveBeenCalledWith("low");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not throw when onEffortChange is not provided", () => {
    renderInProvider(
      <EffortPicker effort="medium" open={true} onOpenChange={vi.fn()} />,
    );
    // "Max" full name is the second occurrence (shortName == name for max)
    const matches = screen.getAllByText("Max");
    const target = matches[matches.length - 1];
    expect(() => fireEvent.click(target)).not.toThrow();
  });

  it("disables the trigger when disabled prop is set", () => {
    renderInProvider(
      <EffortPicker
        effort="high"
        open={false}
        onOpenChange={vi.fn()}
        disabled
      />,
    );
    const trigger = screen.getAllByRole("button")[0];
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("EffortPicker (expanded)", () => {
  it('renders the "Effort:" label and current short name', () => {
    renderInProvider(
      <EffortPicker
        effort="medium"
        open={false}
        onOpenChange={vi.fn()}
        variant="expanded"
      />,
    );
    expect(screen.getByText("Effort:")).toBeTruthy();
    expect(screen.getAllByText("Med").length).toBeGreaterThan(0);
  });

  it("toggles open via trigger click", () => {
    const onOpenChange = vi.fn();
    renderInProvider(
      <EffortPicker
        effort="medium"
        open={false}
        onOpenChange={onOpenChange}
        variant="expanded"
      />,
    );
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});

describe("EffortPicker (form)", () => {
  it("renders the full level name in the trigger", () => {
    renderInProvider(
      <EffortPicker
        effort="max"
        open={false}
        onOpenChange={vi.fn()}
        variant="form"
      />,
    );
    expect(screen.getAllByText("Max").length).toBeGreaterThan(0);
  });
});

// ─── PermissionPicker ────────────────────────────────────────────────────

describe("PermissionPicker (compact)", () => {
  it("renders the current permission short name", () => {
    renderInProvider(
      <PermissionPicker
        permissionMode="default"
        open={false}
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getAllByText("DEF").length).toBeGreaterThan(0);
  });

  it("normalizes 'skip' to bypassPermissions in the trigger label", () => {
    renderInProvider(
      <PermissionPicker
        permissionMode="skip"
        open={false}
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getAllByText("ALL").length).toBeGreaterThan(0);
  });

  it("falls back to first mode when permissionMode is unknown", () => {
    renderInProvider(
      <PermissionPicker
        permissionMode="this-is-not-real"
        open={false}
        onOpenChange={vi.fn()}
      />,
    );
    // first mode is "default" → "DEF"
    expect(screen.getAllByText("DEF").length).toBeGreaterThan(0);
  });

  it("calls onOpenChange when trigger is clicked", () => {
    const onOpenChange = vi.fn();
    renderInProvider(
      <PermissionPicker
        permissionMode="default"
        open={false}
        onOpenChange={onOpenChange}
      />,
    );
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(onOpenChange).toHaveBeenCalled();
  });

  it("lists all permission modes when open", () => {
    renderInProvider(
      <PermissionPicker
        permissionMode="default"
        open={true}
        onOpenChange={vi.fn()}
      />,
    );
    for (const mode of PERMISSION_MODES) {
      expect(screen.getByText(mode.name)).toBeTruthy();
    }
  });

  it("calls onPermissionModeChange and closes when option picked", () => {
    const onChange = vi.fn();
    const onOpenChange = vi.fn();
    renderInProvider(
      <PermissionPicker
        permissionMode="default"
        open={true}
        onPermissionModeChange={onChange}
        onOpenChange={onOpenChange}
      />,
    );
    fireEvent.click(screen.getByText("Plan"));
    expect(onChange).toHaveBeenCalledWith("plan");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not throw without onPermissionModeChange", () => {
    renderInProvider(
      <PermissionPicker
        permissionMode="default"
        open={true}
        onOpenChange={vi.fn()}
      />,
    );
    expect(() => fireEvent.click(screen.getByText("Bypass"))).not.toThrow();
  });

  it("respects disabled prop on trigger", () => {
    renderInProvider(
      <PermissionPicker
        permissionMode="default"
        open={false}
        onOpenChange={vi.fn()}
        disabled
      />,
    );
    expect((screen.getAllByRole("button")[0] as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("PermissionPicker (form)", () => {
  it("renders the current full mode name in trigger", () => {
    renderInProvider(
      <PermissionPicker
        permissionMode="acceptEdits"
        open={false}
        onOpenChange={vi.fn()}
        variant="form"
      />,
    );
    expect(screen.getAllByText("Accept Edits").length).toBeGreaterThan(0);
  });

  it("toggles open on trigger click", () => {
    const onOpenChange = vi.fn();
    renderInProvider(
      <PermissionPicker
        permissionMode="acceptEdits"
        open={false}
        onOpenChange={onOpenChange}
        variant="form"
      />,
    );
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("disables form trigger when disabled prop set", () => {
    renderInProvider(
      <PermissionPicker
        permissionMode="acceptEdits"
        open={false}
        onOpenChange={vi.fn()}
        variant="form"
        disabled
      />,
    );
    expect((screen.getAllByRole("button")[0] as HTMLButtonElement).disabled).toBe(true);
  });
});
