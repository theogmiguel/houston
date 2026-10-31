import { EnvironmentId, ThreadId, type AssistantCitation, type ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import "~/index.css";
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
