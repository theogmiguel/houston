import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ThreadId,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@houston-app/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import "~/index.css";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { act, render } from "../../../test/render";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};

function Harness({
  onCite,
}: {
  onCite: (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
}) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setViewport} data-assistant-citation-viewport="true">
      <p data-assistant-citation-source="message">Selected answer text</p>
      {viewport ? (
        <AssistantSelectionToolbar viewport={viewport} threadRef={threadRef} onCite={onCite} />
      ) : null}
    </div>
  );
}

it("offers Comment on a selection and cites the selected text", async () => {
  using _settings = savedCommentButton(true);
  const onCite = vi.fn<
    (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean
  >(() => true);
  await using screen = await render(<Harness onCite={onCite} />);

  const source = screen.container.querySelector("p")!;
  const range = document.createRange();
  range.setStart(source.firstChild!, 0);
  range.setEnd(source.firstChild!, "Selected".length);
  await act(async () => {
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });

  const comment = page.getByRole("button", { name: "Comment on selected text" });
  await expect.element(comment).toBeVisible();
  await userEvent.click(comment.element());

  expect(onCite).toHaveBeenCalledTimes(1);
  expect(onCite.mock.calls[0]![0]).toMatchObject({
    text: "Selected",
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  expect(window.getSelection()?.isCollapsed).toBe(true);
});

function savedCommentButton(showCommentButtonOnSelection: boolean): Disposable {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, showCommentButtonOnSelection });
  return { [Symbol.dispose]: () => __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS) };
}

async function selectFirstWord(screen: Awaited<ReturnType<typeof render>>) {
  const source = screen.container.querySelector("p")!;
  const range = document.createRange();
  range.setStart(source.firstChild!, 0);
  range.setEnd(source.firstChild!, "Selected".length);
  await act(async () => {
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

it("offers no comment button when the setting is off", async () => {
  using _settings = savedCommentButton(false);
  const onCite = vi.fn(() => true);
  await using screen = await render(<Harness onCite={onCite} />);

  await selectFirstWord(screen);

  await expect
    .poll(() => page.getByRole("button", { name: "Comment on selected text" }).query())
    .toBeNull();
  expect(window.getSelection()?.toString()).toBe("Selected");
  expect(onCite).not.toHaveBeenCalled();
});

it("offers the comment button when the setting is on", async () => {
  using _settings = savedCommentButton(true);
  const onCite = vi.fn(() => true);
  await using screen = await render(<Harness onCite={onCite} />);

  await selectFirstWord(screen);

  await expect
    .element(page.getByRole("button", { name: "Comment on selected text" }))
    .toBeVisible();
});
