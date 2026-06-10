// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FormModelPicker, type Model } from "../ModelPicker";

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
