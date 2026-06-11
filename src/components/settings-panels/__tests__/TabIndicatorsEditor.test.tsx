// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TabIndicatorsEditor } from "../TabIndicatorsEditor";
import { DEFAULT_TAB_INDICATORS, DEFAULT_PALETTE } from "@/lib/messageRenderingConfig";

afterEach(() => { cleanup(); });

function renderEditor(overrides = {}) {
  const onChange = vi.fn();
  const indicators = { ...structuredClone(DEFAULT_TAB_INDICATORS), ...overrides };
  render(
    <TabIndicatorsEditor
      indicators={indicators}
      palette={DEFAULT_PALETTE}
      onChange={onChange}
    />,
  );
  return { onChange };
}

describe("TabIndicatorsEditor", () => {
  it("renders a live preview for each of the four states", () => {
    renderEditor();
    for (const label of ["Error", "Permission request", "Question waiting", "Completed"]) {
      expect(screen.getByLabelText(`${label} preview`)).toBeTruthy();
    }
  });

  it("renders an icon picker and colour input per state", () => {
    renderEditor();
    // 4 icon-picker triggers (aria-label "Icon") + 4 colour inputs.
    expect(screen.getAllByLabelText("Icon").length).toBe(4);
    expect(screen.getAllByLabelText("Colour").length).toBe(4);
  });

  it("toggles the shared bordered chip", () => {
    const { onChange } = renderEditor();
    fireEvent.click(screen.getByLabelText("Bordered chip"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ bordered: true }),
    );
  });

  it("writes a per-state colour without touching other states", () => {
    const { onChange } = renderEditor();
    const errorColor = screen.getAllByLabelText("Colour")[0];
    fireEvent.input(errorColor, { target: { value: "#123456" } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        error: { icon: DEFAULT_TAB_INDICATORS.error.icon, color: "#123456" },
        permission: DEFAULT_TAB_INDICATORS.permission,
      }),
    );
  });

  it("adjusts the shared background opacity when bordered", () => {
    const { onChange } = renderEditor({ bordered: true });
    const slider = screen.getByLabelText("Bg opacity", { selector: "input" });
    fireEvent.change(slider, { target: { value: "40" } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ bgOpacity: 40 }),
    );
  });
});
