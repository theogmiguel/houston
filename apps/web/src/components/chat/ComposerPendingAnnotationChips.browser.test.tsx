import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  ComposerPendingAnnotationChips,
  citationChipLabel,
} from "./ComposerPendingAnnotationChips";

const citation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("message"),
  text: "Terminals keep running when their drawer closes",
  start: 0,
  end: 52,
  prefix: "",
  suffix: "",
  comment: "I don’t agree",
};

it("reads a pending citation as its quote and comment", async () => {
  const onEdit = vi.fn();
  const onRemove = vi.fn();
  await using _screen = await render(
    <ComposerPendingAnnotationChips
      citations={[{ citation, promptStart: 4, promptEnd: 90 }]}
      previewAnnotations={[]}
      onEditCitation={onEdit}
      onRemoveCitation={onRemove}
      onRemovePreviewAnnotation={() => {}}
    />,
    { router: false },
  );

  expect(citationChipLabel(citation)).toBe(
    "“Terminals keep running when their draw…” · I don’t agree",
  );
  const chip = page.getByText("“Terminals keep running when their draw…” · I don’t agree");
  await expect.element(chip).toBeVisible();
  await page.getByRole("button", { name: "Remove citation" }).click();
  expect(onRemove).toHaveBeenCalledTimes(1);
});

it("reads a pending preview annotation by target and comment", async () => {
  await using _screen = await render(
    <ComposerPendingAnnotationChips
      citations={[]}
      previewAnnotations={[
        {
          promptStart: 0,
          promptEnd: 20,
          annotation: {
            id: "annotation",
            pageUrl: "http://localhost:5173",
            pageTitle: "Preview",
            comment: "Use the accent fill",
            elements: [
              {
                id: "element",
                rect: { x: 0, y: 0, width: 0, height: 0 },
                element: {
                  pageUrl: "http://localhost:5173",
                  pageTitle: "Preview",
                  tagName: "button",
                  selector: "header button",
                  componentName: "header button",
                  htmlPreview: "",
                  styles: "",
                  stack: [],
                  source: null,
                  pickedAt: "2026-03-17T00:00:00.000Z",
                },
              },
            ],
            regions: [],
            strokes: [],
            styleChanges: [],
            screenshot: null,
            createdAt: "2026-03-17T00:00:00.000Z",
          },
        },
      ]}
      onEditCitation={() => {}}
      onRemoveCitation={() => {}}
      onRemovePreviewAnnotation={() => {}}
    />,
    { router: false },
  );

  await expect
    .element(page.getByText("Preview · header button · Use the accent fill"))
    .toBeVisible();
});
