// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AskUserQuestionCard } from "../AskUserQuestionCard";
import type { PermissionRequestPayload } from "@/lib/types/permissionRequest";

afterEach(() => { cleanup(); });

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
  };
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

  describe("Other-input Enter-to-submit", () => {
    // Pressing Enter while typing in the "Other" text field should fire the
    // same handler as clicking Send — but only when every question has a
    // valid answer (otherwise the Send button would be disabled and the
    // keystroke must be a no-op rather than submitting partial answers).
    it("submits on Enter when the Other field is the only question and is filled in", () => {
      const onSubmit = vi.fn();
      render(
        <AskUserQuestionCard
          request={makeRequest()}
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByText("Other"));
      const input = screen.getByPlaceholderText("Your answer…");
      fireEvent.change(input, { target: { value: "Magenta" } });
      fireEvent.keyDown(input, { key: "Enter" });

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
        answers: { "Pick a color": "Magenta" },
        annotations: { "Pick a color": { notes: 'User selected Other: "Magenta"' } },
      });
    });

    it("does NOT submit on Enter when Other is empty (Send would be disabled)", () => {
      const onSubmit = vi.fn();
      render(
        <AskUserQuestionCard
          request={makeRequest()}
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByText("Other"));
      const input = screen.getByPlaceholderText("Your answer…");
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("does NOT submit on Enter when another question still needs an answer", () => {
      const onSubmit = vi.fn();
      const twoQuestion = makeRequest({
        toolInput: {
          questions: [
            { question: "Pick a color", header: "Color", options: [{ label: "Red" }] },
            { question: "Pick a fruit", header: "Fruit", options: [{ label: "Apple" }] },
          ],
        },
      });
      render(
        <AskUserQuestionCard
          request={twoQuestion}
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />,
      );
      // Answer question 1 via Other, leave question 2 unanswered.
      fireEvent.click(screen.getAllByText("Other")[0]);
      const input = screen.getByPlaceholderText("Your answer…");
      fireEvent.change(input, { target: { value: "Magenta" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("submits on Enter once every question has an answer (Other is the last one filled)", () => {
      const onSubmit = vi.fn();
      const twoQuestion = makeRequest({
        toolInput: {
          questions: [
            { question: "Pick a color", header: "Color", options: [{ label: "Red" }] },
            { question: "Pick a fruit", header: "Fruit", options: [{ label: "Apple" }] },
          ],
        },
      });
      render(
        <AskUserQuestionCard
          request={twoQuestion}
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByText("Red"));
      fireEvent.click(screen.getAllByText("Other")[1]);
      const input = screen.getByPlaceholderText("Your answer…");
      fireEvent.change(input, { target: { value: "Mango" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onSubmit).toHaveBeenCalledTimes(1);
      const arg = onSubmit.mock.calls[0][0] as { answers: Record<string, string> };
      expect(arg.answers).toEqual({ "Pick a color": "Red", "Pick a fruit": "Mango" });
    });

    it("Shift+Enter does NOT submit (reserved for newline-style intent)", () => {
      // Defensive: if the field ever becomes multi-line, Shift+Enter should
      // not fire submit. Even today we keep this behaviour consistent with
      // the chat composer's split (Enter sends, Shift+Enter newline).
      const onSubmit = vi.fn();
      render(
        <AskUserQuestionCard
          request={makeRequest()}
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByText("Other"));
      const input = screen.getByPlaceholderText("Your answer…");
      fireEvent.change(input, { target: { value: "Magenta" } });
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

      expect(onSubmit).not.toHaveBeenCalled();
    });
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
