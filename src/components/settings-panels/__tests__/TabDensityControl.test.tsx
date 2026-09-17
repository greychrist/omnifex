// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TabDensityControl } from "../TabDensityControl";

afterEach(() => { cleanup(); });

describe("TabDensityControl", () => {
  it("marks the active density as pressed and the other as not", () => {
    render(<TabDensityControl density="expanded" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Expanded" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Compact" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("reports the density the user picked", () => {
    const onChange = vi.fn();
    render(<TabDensityControl density="expanded" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(onChange).toHaveBeenCalledWith("compact");
  });

  it("reports expanded when switching back", () => {
    const onChange = vi.fn();
    render(<TabDensityControl density="compact" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Expanded" }));
    expect(onChange).toHaveBeenCalledWith("expanded");
  });
});
