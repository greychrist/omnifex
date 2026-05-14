// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, screen, cleanup } from "@testing-library/react";
import { Button, buttonVariants } from "../button";

afterEach(() => { cleanup(); });

describe("Button", () => {
  it("renders children", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeTruthy();
  });

  it("forwards onClick", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Hi</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("applies the disabled attribute", () => {
    render(<Button disabled>X</Button>);
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
  });

  it("uses default variant + size when not specified", () => {
    render(<Button>D</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("bg-primary");
    expect(btn.className).toContain("h-9");
  });

  it("applies destructive variant", () => {
    render(<Button variant="destructive">D</Button>);
    expect(screen.getByRole("button").className).toContain("bg-destructive");
  });

  it("applies outline variant", () => {
    render(<Button variant="outline">D</Button>);
    expect(screen.getByRole("button").className).toContain("border-input");
  });

  it("applies ghost variant", () => {
    render(<Button variant="ghost">D</Button>);
    expect(screen.getByRole("button").className).toContain("hover:bg-accent");
  });

  it("applies link variant", () => {
    render(<Button variant="link">D</Button>);
    expect(screen.getByRole("button").className).toContain("underline-offset-4");
  });

  it("applies secondary variant", () => {
    render(<Button variant="secondary">D</Button>);
    expect(screen.getByRole("button").className).toContain("bg-secondary");
  });

  it("applies size sm", () => {
    render(<Button size="sm">D</Button>);
    expect(screen.getByRole("button").className).toContain("h-8");
  });

  it("applies size lg", () => {
    render(<Button size="lg">D</Button>);
    expect(screen.getByRole("button").className).toContain("h-10");
  });

  it("applies size icon", () => {
    render(<Button size="icon">D</Button>);
    expect(screen.getByRole("button").className).toContain("h-9");
    expect(screen.getByRole("button").className).toContain("w-9");
  });

  it("merges custom className", () => {
    render(<Button className="my-extra">D</Button>);
    expect(screen.getByRole("button").className).toContain("my-extra");
  });

  it("forwards ref", () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(<Button ref={ref}>R</Button>);
    expect(ref.current).not.toBeNull();
    expect(ref.current?.tagName).toBe("BUTTON");
  });

  it("buttonVariants returns expected classes for outline + sm", () => {
    const cls = buttonVariants({ variant: "outline", size: "sm" });
    expect(cls).toContain("border-input");
    expect(cls).toContain("h-8");
  });
});
