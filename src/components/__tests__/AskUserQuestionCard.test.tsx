// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AskUserQuestionCard } from "../AskUserQuestionCard";
import type { PermissionRequestPayload } from "@/lib/types/permissionRequest";

afterEach(() => cleanup());

function makeRequest(
  overrides: Partial<PermissionRequestPayload> = {},
): PermissionRequestPayload {
  return {
    requestId: "req-1",
    toolName: "AskUserQuestion",
    displayName: "AskUserQuestion",
    title: "The agent has a question for you",
    description: undefined,
    decisionReason: undefined,
    suggestions: [],
    toolInput: {
      questions: [
        {
          question: "Pick a color",
          header: "Color",
          options: [
            { label: "Red" },
            { label: "Blue" },
          ],
          multiSelect: false,
        },
      ],
    },
    ...overrides,
  } as PermissionRequestPayload;
}

describe("AskUserQuestionCard", () => {
  it("renders inline (no Radix Dialog portal/role)", () => {
    // The card used to wrap itself in a Dialog so it overlaid the chat,
    // which hid the surrounding context — especially painful when several
    // tabs were running at once. We now render inline (alongside
    // PermissionCard) so the question lives in the chat's natural flow and
    // the originating tab shows it without any tab-switch tricks.
    render(
      <AskUserQuestionCard
        request={makeRequest()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("submits the SDK's AskUserQuestionOutput shape with the picked answer", () => {
    const onSubmit = vi.fn();
    render(
      <AskUserQuestionCard
        request={makeRequest()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Blue"));
    fireEvent.click(screen.getByRole("button", { name: /send answer/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      questions: [
        {
          question: "Pick a color",
          header: "Color",
          options: [{ label: "Red" }, { label: "Blue" }],
          multiSelect: false,
        },
      ],
      answers: { "Pick a color": "Blue" },
    });
  });

  it("invokes onCancel when the Cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(
      <AskUserQuestionCard
        request={makeRequest()}
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  describe("collapse / expand", () => {
    // The card can occupy ~60vh + header + footer of the chat when the agent
    // sends 3-4 questions, hiding chat context the user wants to consult
    // before answering. A chevron in the header collapses the card to its
    // header row so the chat above is visible again.
    it("defaults to expanded with questions and Send visible", () => {
      render(
        <AskUserQuestionCard
          request={makeRequest()}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText("Pick a color")).toBeTruthy();
      expect(screen.getByRole("button", { name: /send answer/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /collapse question/i })).toBeTruthy();
    });

    it("collapsing hides the questions, Send, and Cancel buttons", () => {
      render(
        <AskUserQuestionCard
          request={makeRequest()}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /collapse question/i }));

      // Question text and the Send / Cancel footer all gone.
      expect(screen.queryByText("Pick a color")).toBeNull();
      expect(screen.queryByText("Red")).toBeNull();
      expect(screen.queryByText("Blue")).toBeNull();
      expect(screen.queryByRole("button", { name: /send answer/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /^cancel$/i })).toBeNull();
      // Header + toggle stay so the user can re-open.
      expect(screen.getByText("The agent has a question for you")).toBeTruthy();
      expect(screen.getByRole("button", { name: /expand question/i })).toBeTruthy();
    });

    it("re-expanding restores questions and the Send button", () => {
      render(
        <AskUserQuestionCard
          request={makeRequest()}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: /collapse question/i }));
      fireEvent.click(screen.getByRole("button", { name: /expand question/i }));

      expect(screen.getByText("Pick a color")).toBeTruthy();
      expect(screen.getByRole("button", { name: /send answer/i })).toBeTruthy();
    });
  });
});
