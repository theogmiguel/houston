import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { NeedsYouAnswerBlock } from "./needs-you-answer";
import type { NeedsYouAnswerView } from "./needs-you-answer-model";

function inputView(overrides: Partial<Extract<NeedsYouAnswerView, { kind: "input" }>> = {}) {
  return {
    kind: "input" as const,
    requestId: "request-1",
    question: {
      id: "question-1",
      text: "Which branch should the change land on?",
      header: "Branch",
      options: [
        { label: "Keep", value: "keep" },
        { label: "Drop", value: "drop" },
      ],
      multiSelect: false,
      allowCustomAnswer: true,
    },
    progress: { index: 0, total: 1 },
    selectedValues: [],
    pending: false,
    error: null,
    onToggleOption: () => {},
    onSubmit: () => {},
    onReply: () => {},
    ...overrides,
  } satisfies Extract<NeedsYouAnswerView, { kind: "input" }>;
}

describe("NeedsYouAnswerBlock", () => {
  it("shows a question, one button per option and Reply…", async () => {
    const onToggleOption = vi.fn();
    await using screen = await render(<NeedsYouAnswerBlock view={inputView({ onToggleOption })} />);

    expect(screen.getByText("Which branch should the change land on?")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(onToggleOption).toHaveBeenCalledExactlyOnceWith("keep");
    await userEvent.click(screen.getByRole("button", { name: "Drop" }));
    expect(onToggleOption).toHaveBeenLastCalledWith("drop");
    await expect.element(screen.getByRole("button", { name: "Reply…" })).toBeVisible();
  });

  it("submits free text from the inline reply field", async () => {
    const onReply = vi.fn();
    await using screen = await render(<NeedsYouAnswerBlock view={inputView({ onReply })} />);

    await userEvent.click(screen.getByRole("button", { name: "Reply…" }));
    const field = screen.getByRole("textbox", { name: "Reply…" });
    await expect.element(field).toBeVisible();
    await userEvent.type(field, "use the release branch{Enter}");
    expect(onReply).toHaveBeenCalledExactlyOnceWith("use the release branch");
  });

  it("sends a multi-select answer from its Send action", async () => {
    const onSubmit = vi.fn();
    await using screen = await render(
      <NeedsYouAnswerBlock
        view={inputView({
          onSubmit,
          question: {
            ...inputView().question,
            multiSelect: true,
          },
          selectedValues: ["keep"],
        })}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("shows an approval command with Approve and Deny", async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    await using screen = await render(
      <NeedsYouAnswerBlock
        view={{
          kind: "approval",
          requestId: "request-1",
          command: "rm -rf build",
          pending: false,
          error: null,
          canRespond: true,
          onApprove,
          onDeny,
        }}
      />,
    );

    expect(screen.getByText("rm -rf build")).toBeVisible();
    expect(screen.container.querySelector("p.font-mono")?.textContent).toBe("rm -rf build");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onApprove).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDeny).toHaveBeenCalledOnce();
  });

  it("shows a failure reason with Retry", async () => {
    const onRetry = vi.fn();
    await using screen = await render(
      <NeedsYouAnswerBlock
        view={{
          kind: "failed",
          reason: "The provider rejected the request.",
          pending: false,
          error: null,
          onRetry,
        }}
      />,
    );

    expect(screen.getByText("The provider rejected the request.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("shows skeleton lines while the request loads", async () => {
    await using screen = await render(<NeedsYouAnswerBlock view={{ kind: "loading" }} />);
    expect(screen.container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it("shows a bounded error message when an answer fails", async () => {
    await using screen = await render(
      <NeedsYouAnswerBlock
        view={inputView({ error: "This request was already answered in another window." })}
      />,
    );
    expect(screen.getByText("This request was already answered in another window.")).toBeVisible();
  });
});
