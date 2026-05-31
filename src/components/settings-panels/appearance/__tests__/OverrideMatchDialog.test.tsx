// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { OverrideMatchDialog } from "../OverrideMatchDialog";
import type { MatchCondition } from "@/lib/messageRenderingConfig";

afterEach(() => { cleanup(); });

type SaveFn = (d: { label: string; match: MatchCondition[] }) => void;

function renderDialog(opts: {
  initialMatch?: MatchCondition[];
  onSave?: ReturnType<typeof vi.fn<SaveFn>>;
} = {}) {
  const onSave = opts.onSave ?? vi.fn<SaveFn>();
  render(
    <OverrideMatchDialog
      open
      mode="create"
      category="system"
      categoryLabel="System"
      initialLabel=""
      initialMatch={opts.initialMatch ?? []}
      exampleRaw={{ type: "system" }}
      onSave={onSave}
      onCancel={vi.fn()}
    />,
  );
  return { onSave };
}

describe("OverrideMatchDialog — kind picker", () => {
  it("'Match a kind' adds a $kind condition rendered as a dropdown (not free text)", () => {
    renderDialog({});
    fireEvent.click(screen.getByRole("button", { name: /Match a kind/i }));

    // The value cell is now a kind dropdown (combobox), not a value textbox.
    expect(screen.getByLabelText("Condition 1 kind")).toBeTruthy();
    expect(screen.queryByLabelText("Condition 1 value")).toBeNull();
    // The path is pinned to the synthetic $kind selector.
    expect((screen.getByLabelText("Condition 1 path") as HTMLInputElement).value).toBe("$kind");
  });

  it("saves a $kind eq <kindId> match for a category kind", () => {
    const { onSave } = renderDialog({});
    fireEvent.change(screen.getByLabelText("Override label"), { target: { value: "My rule" } });
    fireEvent.click(screen.getByRole("button", { name: /Match a kind/i }));
    fireEvent.click(screen.getByRole("button", { name: "Add override" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const { match } = onSave.mock.calls[0][0];
    expect(match).toHaveLength(1);
    expect(match[0].path).toBe("$kind");
    expect(match[0].op).toBe("eq");
    // Pre-filled with a real system-category kind id (a string, not "[object…]").
    expect(typeof match[0].value).toBe("string");
    expect((match[0].value as string).length).toBeGreaterThan(0);
  });

  it("renders a normal text value box for a non-$kind condition", () => {
    renderDialog({ initialMatch: [{ path: "subtype", op: "eq", value: "notification" }] });
    expect(screen.getByLabelText("Condition 1 value")).toBeTruthy();
    expect(screen.queryByLabelText("Condition 1 kind")).toBeNull();
  });

  it("pre-selects the existing kind on an edited $kind condition", () => {
    renderDialog({ initialMatch: [{ path: "$kind", op: "eq", value: "permission.askUserQuestion" }] });
    // The kind dropdown trigger reflects the current value.
    expect(screen.getByText("permission.askUserQuestion")).toBeTruthy();
  });
});
