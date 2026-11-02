import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { DraftId } from "../../composerDraftStore";
import { useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";
import { render } from "../../../test/render";
import { ComposerAttachmentFileList } from "./ComposerAttachmentStrip";

const environmentId = EnvironmentId.make("environment");

afterEach(() => {
  useAttachmentUploadStore.setState({ uploadsByImageId: {} });
});

function fileAttachment(input: {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes?: number;
  readonly file?: File | null;
}) {
  return {
    type: "file" as const,
    id: input.id,
    name: input.name,
    mimeType: "application/pdf",
    sizeBytes: input.sizeBytes ?? 1024,
    file:
      input.file === undefined
        ? new File(["pdf"], input.name, { type: "application/pdf" })
        : input.file,
  };
}

function renderFileList(input: {
  readonly files: ReadonlyArray<ReturnType<typeof fileAttachment>>;
  readonly fileStagingLimit?: number | null;
  readonly onReattachFiles?: (files: File[]) => void;
}) {
  return render(
    <ComposerAttachmentFileList
      files={input.files}
      resolvedTheme="light"
      supportsAttachmentUploads
      maxFileAttachmentBytes={10_000}
      fileStagingLimit={input.fileStagingLimit === undefined ? 10_000 : input.fileStagingLimit}
      environmentId={environmentId}
      attachmentDraftTarget={DraftId.make("draft")}
      canOperateThread
      onPreviewFile={() => {}}
      onRemoveFile={() => {}}
      onReattachFiles={input.onReattachFiles ?? (() => {})}
    />,
    { router: false },
  );
}

it("counts an upload where the remove control lands", async () => {
  const file = fileAttachment({ id: "trace", name: "trace.log" });
  useAttachmentUploadStore.setState({
    uploadsByImageId: {
      [file.id]: { status: "uploading", environmentId, progress: 0.42 },
    },
  });

  await using screen = await renderFileList({ files: [file] });

  const tile = screen.container.querySelector<HTMLElement>('[data-attachment-tile="file"]')!;
  expect(tile.getAttribute("data-attachment-tile-state")).toBe("uploading");
  await expect.element(page.getByText("42%")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Remove trace.log" }))
    .not.toBeInTheDocument();
});

it("holds a queued upload as a dashed tile without a remove control", async () => {
  const file = fileAttachment({ id: "usage", name: "usage.csv" });
  useAttachmentUploadStore.setState({
    uploadsByImageId: {
      [file.id]: { status: "queued", environmentId },
    },
  });

  await using screen = await renderFileList({ files: [file] });

  const tile = screen.container.querySelector<HTMLElement>('[data-attachment-tile="file"]')!;
  expect(tile.getAttribute("data-attachment-tile-state")).toBe("queued");
  expect(tile.classList.contains("border-dashed")).toBe(true);
  await expect
    .element(page.getByRole("button", { name: "Remove usage.csv" }))
    .not.toBeInTheDocument();
});

it("offers Attach again on a tile whose file handle was lost", async () => {
  const onReattachFiles = vi.fn();
  await using screen = await renderFileList({
    files: [fileAttachment({ id: "spec", name: "spec.pdf", file: null })],
    onReattachFiles,
  });

  const tile = screen.container.querySelector<HTMLElement>('[data-attachment-tile="file"]')!;
  expect(tile.getAttribute("data-attachment-tile-state")).toBe("failed");
  await expect.element(page.getByRole("button", { name: "Attach spec.pdf again" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Remove spec.pdf" })).toBeVisible();
  expect(screen.container.querySelector("input[type=file]")?.getAttribute("accept")).toBe(".pdf");
});

it("asks the user to remove a marker too large to attach again", async () => {
  await using _screen = await renderFileList({
    files: [fileAttachment({ id: "huge", name: "huge.pdf", sizeBytes: 2048, file: null })],
    fileStagingLimit: 1024,
  });

  await expect
    .element(page.getByRole("button", { name: "Attach huge.pdf again" }))
    .not.toBeInTheDocument();
  await expect
    .element(
      page.getByRole("img", {
        name: "huge.pdf was not saved with this draft; remove it to send",
      }),
    )
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Remove huge.pdf" })).toBeVisible();
});
