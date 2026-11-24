import {
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@houston-app/contracts";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import "~/index.css";
import { act, render } from "../../../test/render";

const mocks = vi.hoisted(() => ({ observeSource: vi.fn(), dispose: vi.fn() }));
vi.mock(import("./AssistantCitationSource"), async (importOriginal) => ({
  ...(await importOriginal()),
  observeAssistantCitationCommentSource: mocks.observeSource,
}));
vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => vi.fn(),
  Link: (({ children }: { children: ReactNode }) => <a>{children}</a>) as never,
}));

import { AssistantCitationChip } from "./AssistantCitationChip";

const citation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("source"),
  text: "hello",
  start: 0,
  end: 5,
  prefix: "",
  suffix: "",
};

// The mocked source observer is shared, so every test starts by resetting it.
function setup({ sourceStyle = "" } = {}) {
  mocks.observeSource.mockReset().mockReturnValue(mocks.dispose);
  mocks.dispose.mockClear();
  const source = document.createElement("p");
  source.textContent = "hello";
  source.style.cssText = sourceStyle;
  document.body.append(source);
  const range = document.createRange();
  range.selectNodeContents(source);
  const sourceAnchor = { source, range, viewport: document.body } as AssistantCitationSourceAnchor;
  return { sourceAnchor, source, [Symbol.dispose]: () => source.remove() };
}

// A cited answer inside a real scroll viewport, so scrolling can carry it out of view.
function setupScrollViewport() {
  mocks.observeSource.mockReset().mockReturnValue(mocks.dispose);
  mocks.dispose.mockClear();
  const viewport = document.createElement("div");
  viewport.dataset.assistantCitationViewport = "true";
  viewport.style.cssText = "position: relative; width: 400px; height: 120px; overflow: auto;";
  const source = document.createElement("p");
  source.textContent = "hello";
  source.style.margin = "0";
  const tail = document.createElement("div");
  tail.style.height = "400px";
  viewport.append(source, tail);
  document.body.append(viewport);
  const range = document.createRange();
  range.selectNodeContents(source);
  const sourceAnchor = { source, range, viewport } as AssistantCitationSourceAnchor;
  return {
    sourceAnchor,
    source,
    viewport,
    [Symbol.dispose]: () => viewport.remove(),
  };
}

function mount(sourceAnchor: AssistantCitationSourceAnchor, onSave: () => boolean) {
  function Composer() {
    const [open, setOpen] = useState(true);
    return (
      <AssistantCitationChip
        citation={citation}
        commentEditor={{ open, sourceAnchor, onOpenChange: setOpen, onSave }}
      />
    );
  }
  return render(<Composer />);
}

const textarea = () =>
  document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment on selected text"]');

async function typeComment(value: string) {
  const input = textarea()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function removeSource() {
  const { onUnavailable } = mocks.observeSource.mock.lastCall![0];
  await act(async () => onUnavailable());
}

async function clickButton(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.click());
}

describe("citation comment source disappearance", () => {
  it("preserves an over-length draft at the composer until it can be shortened and saved", async () => {
    using source = setup();
    const onSave = vi.fn(() => true);
    await using _screen = await mount(source.sourceAnchor, onSave);
    const draft = "x".repeat(ASSISTANT_CITATION_MAX_COMMENT_LENGTH + 1);
    await typeComment(draft);
    await removeSource();

    expect(textarea()?.value).toBe(draft);
    expect(textarea()?.getAttribute("aria-invalid")).toBe("true");
    expect(onSave).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalled();
    expect(mocks.observeSource).toHaveBeenCalledTimes(1);

    await typeComment("shortened comment");
    await clickButton("Save");
    expect(onSave).toHaveBeenCalledWith("shortened comment");
    expect(textarea()).toBeNull();
  });

  it("preserves a rejected save and allows a later retry", async () => {
    using source = setup();
    const onSave = vi.fn(() => false);
    await using _screen = await mount(source.sourceAnchor, onSave);
    await typeComment("keep this draft");
    await removeSource();

    expect(onSave).toHaveBeenCalledWith("keep this draft");
    expect(textarea()?.value).toBe("keep this draft");
    onSave.mockReturnValue(true);
    await clickButton("Save");
    expect(onSave).toHaveBeenLastCalledWith("keep this draft");
    expect(textarea()).toBeNull();
  });
});

describe("citation comment placement", () => {
  it("renders the editor in a popover below the cited range", async () => {
    using source = setup({ sourceStyle: "position: fixed; top: 8px; left: 8px; margin: 0;" });
    await using _screen = await mount(
      source.sourceAnchor,
      vi.fn(() => true),
    );
    const popup = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="popover-popup"]');
      expect(found, "popover popup").not.toBeNull();
      return found!;
    });
    expect(popup.contains(textarea())).toBe(true);

    const rangeRect = source.sourceAnchor.range.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    expect(popupRect.top).toBeGreaterThanOrEqual(rangeRect.bottom - 1);

    await userEvent.click(textarea()!);
    await userEvent.keyboard("note");

    expect(textarea()?.value).toBe("note");
    expect(popup.getBoundingClientRect().width).toBeGreaterThan(0);
  });

  it("flips above the range when there is no room below", async () => {
    using source = setup({ sourceStyle: "position: fixed; bottom: 8px; left: 8px; margin: 0;" });
    await using _screen = await mount(
      source.sourceAnchor,
      vi.fn(() => true),
    );
    const popup = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="popover-popup"]');
      expect(found, "popover popup").not.toBeNull();
      return found!;
    });

    const rangeRect = source.sourceAnchor.range.getBoundingClientRect();
    expect(popup.getBoundingClientRect().bottom).toBeLessThanOrEqual(rangeRect.top + 1);
  });

  it("commits the draft and closes when the cited range scrolls out of the viewport", async () => {
    using source = setupScrollViewport();
    const onSave = vi.fn(() => true);
    await using _screen = await mount(source.sourceAnchor, onSave);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="popover-popup"]')).not.toBeNull(),
    );
    await typeComment("scrolled away");

    await act(async () => {
      source.viewport.scrollTop = 300;
      source.viewport.dispatchEvent(new Event("scroll"));
    });

    await vi.waitFor(() => expect(textarea()).toBeNull());
    expect(onSave).toHaveBeenCalledWith("scrolled away");
  });

  it("commits the draft when the user clicks outside the popover", async () => {
    using source = setup();
    const onSave = vi.fn(() => true);
    await using _screen = await mount(source.sourceAnchor, onSave);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="popover-popup"]')).not.toBeNull(),
    );
    await typeComment("outside draft");

    const outside = document.createElement("button");
    outside.textContent = "outside";
    outside.style.cssText = "position: fixed; right: 8px; bottom: 8px;";
    document.body.append(outside);
    try {
      await userEvent.click(outside);
    } finally {
      outside.remove();
    }

    await vi.waitFor(() => expect(textarea()).toBeNull());
    expect(onSave).toHaveBeenCalledWith("outside draft");
  });
});
