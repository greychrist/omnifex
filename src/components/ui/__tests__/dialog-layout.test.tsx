// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Dialog, DialogContent } from "../dialog";

afterEach(() => { cleanup(); });

// DialogContent is a grid with one IMPLICIT `auto` column, which one wide child
// can widen past the content box. jsdom has no layout, so the class that caps
// it (`grid-cols-1`, minmax(0, 1fr)) is asserted.
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
