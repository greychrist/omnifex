// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FormModelPicker, ModelPickerDropdown, type Model } from "../ModelPicker";

afterEach(() => { cleanup(); });

const MODELS: Model[] = [
  { id: "opus", name: "Opus", description: "Most capable", icon: null, shortName: "Op", color: "" },
  { id: "sonnet", name: "Sonnet", description: "Balanced", icon: null, shortName: "So", color: "" },
];

function renderPicker(overrides: Partial<React.ComponentProps<typeof FormModelPicker>> = {}) {
  const onSelect = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <FormModelPicker
      selectedModelData={MODELS[0]}
      models={MODELS}
      selectedModel="opus"
      onSelect={onSelect}
      open={true}
      onOpenChange={onOpenChange}
      {...overrides}
    />,
  );
  return { onSelect, onOpenChange };
}

describe("FormModelPicker", () => {
  // Effort and permission pickers close their popover after a pick
  // (ControlBar handleSelect → onOpenChange(false)). The model picker must
  // match: selecting a model applied the change but left the dropdown open
  // (symptom: "I click it, it changes, but it doesn't close"). Same code path
  // in the session context popover and the account editor.
  it("applies the selection and closes the dropdown when a model is picked", () => {
    const { onSelect, onOpenChange } = renderPicker();
    fireEvent.click(screen.getByText("Sonnet"));
    expect(onSelect).toHaveBeenCalledWith("sonnet");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("ModelPickerDropdown — effort and more-models panels", () => {
  function renderDropdown(overrides: Partial<React.ComponentProps<typeof ModelPickerDropdown>> = {}) {
    const onSelect = vi.fn();
    const onEffortSelect = vi.fn();
    render(
      <ModelPickerDropdown
        models={MODELS}
        selectedModel="opus"
        onSelect={onSelect}
        effort="medium"
        onEffortSelect={onEffortSelect}
        extras={[{ id: "claude-opus-5-5", name: "Opus 5.5", description: "", icon: null, shortName: "O", color: "" }]}
        {...overrides}
      />,
    );
    return { onSelect, onEffortSelect };
  }

  it("shows the current effort on a row of its own, under the models", () => {
    renderDropdown();
    const row = screen.getByRole("button", { name: /effort/i });
    expect(row.textContent).toContain("Medium");
  });

  it("swaps to the effort list and pushes the pick through", () => {
    const { onEffortSelect } = renderDropdown();
    fireEvent.click(screen.getByRole("button", { name: /effort/i }));
    // The model rows are gone — this is one panel, not a nested popover.
    expect(screen.queryByText("Sonnet")).toBeNull();
    // The row's accessible name starts with the level's short tag ("Hi"),
    // so match the label text and let the click bubble to the button.
    fireEvent.click(screen.getByText("High"));
    expect(onEffortSelect).toHaveBeenCalledWith("high");
  });

  it("goes back to the models from the effort list", () => {
    renderDropdown();
    fireEvent.click(screen.getByRole("button", { name: /effort/i }));
    // Not /back/i — the xhigh level's description says "falls back to High".
    fireEvent.click(screen.getByRole("button", { name: /back to models/i }));
    expect(screen.getByText("Sonnet")).toBeTruthy();
  });

  it("offers the extra models behind their own row", () => {
    const { onSelect } = renderDropdown();
    expect(screen.queryByText("Opus 5.5")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /more models/i }));
    fireEvent.click(screen.getByRole("button", { name: /Opus 5\.5/ }));
    expect(onSelect).toHaveBeenCalledWith("claude-opus-5-5");
  });

  it("puts older versions behind More models, ahead of the extras", () => {
    const { onSelect } = renderDropdown({
      models: [
        { id: "opus", name: "Opus 5.5", description: "", icon: null, shortName: "O", color: "" },
        { id: "claude-opus-5", name: "Opus 5", description: "", icon: null, shortName: "O", color: "" },
      ],
      extras: [{ id: "claude-opus-4-5", name: "Opus 4.5", description: "", icon: null, shortName: "O", color: "" }],
    });
    expect(screen.queryByText("Opus 5")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /more models/i }));
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names.indexOf("Opus 5")).toBeLessThan(names.indexOf("Opus 4.5"));
    fireEvent.click(screen.getByRole("button", { name: "Opus 5" }));
    expect(onSelect).toHaveBeenCalledWith("claude-opus-5");
  });

  it("offers More models for older versions even with no extras", () => {
    renderDropdown({
      extras: undefined,
      models: [
        { id: "opus", name: "Opus 5.5", description: "", icon: null, shortName: "O", color: "" },
        { id: "claude-opus-5", name: "Opus 5", description: "", icon: null, shortName: "O", color: "" },
      ],
    });
    expect(screen.getByRole("button", { name: /more models/i })).toBeTruthy();
  });

  it("hides both rows when the caller supplies neither", () => {
    renderDropdown({ effort: undefined, onEffortSelect: undefined, extras: [] });
    expect(screen.queryByRole("button", { name: /effort/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /more models/i })).toBeNull();
  });
});
