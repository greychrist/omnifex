// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FormModelPicker, ModelPickerDropdown, type Model } from "../ModelPicker";
import { SHADES, screenChartMode } from "@/lib/costChartPalette";

afterEach(() => { cleanup(); });

const MODELS: Model[] = [
  { id: "opus", name: "Opus", description: "Most capable", icon: null, shortName: "Op" },
  { id: "sonnet", name: "Sonnet", description: "Balanced", icon: null, shortName: "So" },
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
        extras={[{ id: "claude-opus-5-5", name: "Opus 5.5", description: "", icon: null, shortName: "O" }]}
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
        { id: "opus", name: "Opus 5.5", description: "", icon: null, shortName: "O" },
        { id: "claude-opus-5", name: "Opus 5", description: "", icon: null, shortName: "O" },
      ],
      extras: [{ id: "claude-opus-4-5", name: "Opus 4.5", description: "", icon: null, shortName: "O" }],
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
        { id: "opus", name: "Opus 5.5", description: "", icon: null, shortName: "O" },
        { id: "claude-opus-5", name: "Opus 5", description: "", icon: null, shortName: "O" },
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

describe("ModelPickerDropdown — the selected row and the tier colours", () => {
  const CATALOG: Model[] = [
    { id: "default", name: "Opus 5.5 *", description: "Everyday", icon: <span data-icon />, shortName: "O", resolvedId: "claude-opus-5-5[1m]" },
    { id: "claude-fable-5-1[1m]", name: "Fable 5.1", description: "Toughest", icon: <span data-icon />, shortName: "F" },
    { id: "claude-haiku-5-5", name: "Haiku 5.5", description: "Fastest", icon: <span data-icon />, shortName: "H" },
    { id: "mystery", name: "Mystery", description: "", icon: <span data-icon />, shortName: "M" },
  ];
  const rowOf = (name: string) => screen.getByText(name).closest("button") as HTMLElement;
  // `hover:bg-accent` is on every row; the active fill is the bare class.
  const isHighlighted = (name: string) => rowOf(name).className.split(/\s+/).includes("bg-accent");
  const iconOf = (name: string) => rowOf(name).querySelector("[data-icon]")!.parentElement as HTMLElement;

  it("highlights the pick, and the merged default row when the pick is the model it stands for", () => {
    render(<ModelPickerDropdown models={CATALOG} selectedModel="claude-fable-5-1[1m]" onSelect={() => {}} />);
    expect(isHighlighted("Fable 5.1")).toBe(true);
    expect(isHighlighted("Opus 5.5 *")).toBe(false);
    cleanup();
    render(<ModelPickerDropdown models={CATALOG} selectedModel="claude-opus-5-5[1m]" onSelect={() => {}} />);
    expect(isHighlighted("Opus 5.5 *")).toBe(true);
    expect(isHighlighted("Fable 5.1")).toBe(false);
  });

  // A `[1m]` context opt-in is a request flag, not another model: the pick
  // `claude-opus-5-5[1m]` is the row whose model is `claude-opus-5-5`.
  it("matches the pick to a row across a [1m] suffix", () => {
    render(<ModelPickerDropdown models={CATALOG} selectedModel="claude-haiku-5-5[1m]" onSelect={() => {}} />);
    expect(isHighlighted("Haiku 5.5")).toBe(true);
    cleanup();
    render(<ModelPickerDropdown models={CATALOG} selectedModel="claude-opus-5-5" onSelect={() => {}} />);
    expect(isHighlighted("Opus 5.5 *")).toBe(true);
  });

  // The icon wears the Cost Report's colour for the model — its price tier,
  // its version's shade — so a model looks the same here, in the chart and
  // on a Modern model-change line. The merged default row takes the colour
  // of the model it stands for.
  it("colours each row's icon by tier, the default row by the model it stands for", () => {
    render(<ModelPickerDropdown models={CATALOG} selectedModel="mystery" onSelect={() => {}} />);
    const mode = screenChartMode();
    expect(iconOf("Opus 5.5 *").style.color).toBe(hexToRgb(SHADES[mode].opus[0]));
    expect(iconOf("Fable 5.1").style.color).toBe(hexToRgb(SHADES[mode].fable[0]));
    expect(iconOf("Haiku 5.5").style.color).toBe(hexToRgb(SHADES[mode].haiku[0]));
    expect(iconOf("Mystery").style.color).toBe("");
  });
});

function hexToRgb(h: string): string {
  return `rgb(${[1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(", ")})`;
}
