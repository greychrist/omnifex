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
    for (const label of [
      "Error",
      "Permission request",
      "Question waiting",
      "Completed",
      "Prompt cache expiring",
    ]) {
      expect(screen.getByLabelText(`${label} preview`)).toBeTruthy();
    }
  });

  it("renders an icon picker and colour input per state", () => {
    renderEditor();
    // One icon-picker trigger (aria-label "Icon") + one colour input per state:
    // error, permission, question, complete, cacheExpiring.
    expect(screen.getAllByLabelText("Icon").length).toBe(5);
    expect(screen.getAllByLabelText("Colour").length).toBe(5);
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

  // "MessageCircleQuestion" is the shipped default for the question state and
  // is wider than the picker's column, so a fresh install shows the overflow:
  // the name pushed the chevron out of the button and over the colour input
  // sitting beside it.
  //
  // jsdom has no layout engine, so this asserts the layout contract that makes
  // the overflow impossible rather than measuring the overflow itself — the
  // label must be allowed to shrink and clip, and the chevron must not be
  // shrinkable at all.
  it("clips a long icon name instead of pushing the chevron out", () => {
    renderEditor();
    const label = screen.getByText("MessageCircleQuestion");
    expect(label.className).toContain("truncate");
    expect(label.parentElement?.className).toContain("min-w-0");

    const chevron = screen
      .getAllByLabelText("Icon")[2]
      .querySelector("svg:last-of-type");
    expect(chevron?.getAttribute("class")).toContain("shrink-0");
  });
});
