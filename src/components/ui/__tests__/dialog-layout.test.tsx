// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Dialog, DialogContent } from "../dialog";

afterEach(() => { cleanup(); });

// Reproduces "the account editor lets its content stretch off the sides".
//
// DialogContent is `display: grid` with a single IMPLICIT column, and an
// implicit column is sized `auto`. An auto track's base size is the largest
// min-content contribution of its items — which is allowed to exceed the
// container's own content box. So one wide child widens the track for every
// other child, and everything past the padding edge is clipped by the
// `overflow-y-auto` scroll container.
//
// The real trigger is SessionDefaultsRow: three `flex-1` fields whose triggers
// are `whitespace-nowrap` buttons, so the row's min-content is
// 3 x (widest trigger) + gaps. Measured in Chrome against the built CSS at
// max-w-lg (512px box / 462px content): the row's min-content is 470px with a
// long "Account Default (…)" model label, which pushed the track to 470 and
// clipped the Save button and the right edge of every input.
//
// The fix makes the column EXPLICIT as `minmax(0, 1fr)` (Tailwind's
// `grid-cols-1`), which caps the track at the content box; the children then
// shrink and their `truncate` labels ellipsize. Verified in Chrome: with the
// cap, scrollWidth === clientWidth and the last field's right edge lands
// exactly on the content edge, even with absurdly long labels.
//
// jsdom has no layout engine, so the measurement above can't be asserted here.
// What IS assertable is the class that produces it.
describe("DialogContent grid track", () => {
  it("caps its column at the content box so a wide child can't stretch the dialog", () => {
    render(
      <Dialog open>
        <DialogContent>
          <span>body</span>
        </DialogContent>
      </Dialog>,
    );
    const content = screen.getByRole("dialog");
    expect(content.className).toContain("grid-cols-1");
  });

  it("lets a caller override the column definition", () => {
    render(
      <Dialog open>
        <DialogContent className="grid-cols-2">
          <span>body</span>
        </DialogContent>
      </Dialog>,
    );
    const content = screen.getByRole("dialog");
    // tailwind-merge must drop the base grid-cols-1 rather than emit both.
    expect(content.className).toContain("grid-cols-2");
    expect(content.className).not.toContain("grid-cols-1");
  });
});
