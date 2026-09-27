// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TabMaxWidthControl } from "../TabMaxWidthControl";
import { TAB_MAX_WIDTH_RANGE } from "@/lib/messageRenderingConfig";

afterEach(() => { cleanup(); });

describe("TabMaxWidthControl", () => {
  it("shows the current width and spans the allowed range", () => {
    render(<TabMaxWidthControl maxWidth={250} onChange={vi.fn()} />);
    const slider = screen.getByLabelText("Max tab width");
    expect(slider.getAttribute("min")).toBe(String(TAB_MAX_WIDTH_RANGE.min));
    expect(slider.getAttribute("max")).toBe(String(TAB_MAX_WIDTH_RANGE.max));
    expect((slider as HTMLInputElement).value).toBe("250");
    expect(screen.getByText("250px")).toBeTruthy();
  });

  it("reports the width the user picked as a number", () => {
    const onChange = vi.fn();
    render(<TabMaxWidthControl maxWidth={250} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Max tab width"), { target: { value: "320" } });
    expect(onChange).toHaveBeenCalledWith(320);
  });
});
