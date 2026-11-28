import { describe, expect, it } from "vite-plus/test";

import {
  boundNeedsYouText,
  NEEDS_YOU_TEXT_MAX,
  needsYouAnswerKey,
  needsYouFailureReason,
} from "./needs-you-answer-model";

describe("boundNeedsYouText", () => {
  it("collapses whitespace and trims the ends", () => {
    expect(boundNeedsYouText("  first\n\nsecond\t third  ")).toBe("first second third");
  });

  it("keeps text at or under the bound unchanged", () => {
    expect(boundNeedsYouText("short")).toBe("short");
    expect(boundNeedsYouText("x".repeat(NEEDS_YOU_TEXT_MAX))).toBe("x".repeat(NEEDS_YOU_TEXT_MAX));
  });

  it("truncates longer text with an ellipsis at the bound", () => {
    const bounded = boundNeedsYouText("x".repeat(NEEDS_YOU_TEXT_MAX + 10));
    expect(bounded).toHaveLength(NEEDS_YOU_TEXT_MAX + 1);
    expect(bounded.endsWith("…")).toBe(true);
  });

  it("does not split a character pair when it truncates", () => {
    expect(boundNeedsYouText("😀😀😀", 2)).toBe("😀😀…");
  });
});

describe("needsYouFailureReason", () => {
  it("uses the runtime error", () => {
    expect(
      needsYouFailureReason({
        runtime: { lastError: "The provider rejected the request." },
      }),
    ).toBe("The provider rejected the request.");
  });

  it("falls back when the thread has no reported error", () => {
    expect(needsYouFailureReason({ runtime: null })).toBe("The last run failed.");
    expect(needsYouFailureReason({ runtime: { lastError: "   " } })).toBe("The last run failed.");
  });

  it("bounds a long error", () => {
    expect(
      needsYouFailureReason({ runtime: { lastError: "x".repeat(NEEDS_YOU_TEXT_MAX + 5) } }),
    ).toHaveLength(NEEDS_YOU_TEXT_MAX + 1);
  });
});

describe("needsYouAnswerKey", () => {
  const noop = () => {};

  it("changes when the question changes without remounting on pending or error", () => {
    const base = {
      kind: "input" as const,
      requestId: "request-1",
      question: {
        id: "question-1",
        text: "Which branch?",
        header: "Branch",
        options: [],
        multiSelect: false,
        allowCustomAnswer: true,
      },
      progress: { index: 0, total: 1 },
      selectedValues: [],
      pending: false,
      error: null,
      onToggleOption: noop,
      onSubmit: noop,
      onReply: noop,
    };
    expect(needsYouAnswerKey(base)).toBe("input:request-1:question-1");
    expect(needsYouAnswerKey({ ...base, pending: true, error: "failed" })).toBe(
      needsYouAnswerKey(base),
    );
    expect(
      needsYouAnswerKey({ ...base, question: { ...base.question, id: "question-2" } }),
    ).not.toBe(needsYouAnswerKey(base));
  });
});
