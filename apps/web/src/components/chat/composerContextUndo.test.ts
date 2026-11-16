import type { PreviewAnnotationPayload } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import {
  buildMessageContext,
  fileContextReference,
  previewAnnotationContextId,
} from "../../lib/composerContextRecords";
import {
  reconcileAttachmentContextReferences,
  type RetainedAttachmentContextPayloads,
} from "./composerContextUndo";

const binary = new File(["binary"], "context.png", { type: "image/png" });
const image = {
  type: "image",
  id: "annotation-1",
  name: "annotation.png",
  mimeType: "image/png",
  sizeBytes: binary.size,
  previewUrl: "blob:annotation",
  file: binary,
} satisfies ComposerImageAttachment;
const annotation = {
  id: "annotation-1",
  pageUrl: "https://example.com",
  pageTitle: "Example",
  comment: "Fix this",
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: {
    dataUrl: "data:image/png;base64,YmluYXJ5",
    width: 1,
    height: 1,
    cropRect: { x: 0, y: 0, width: 1, height: 1 },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
} satisfies PreviewAnnotationPayload;

const notes = {
  type: "file",
  id: "file-1",
  name: "notes.md",
  mimeType: "text/markdown",
  sizeBytes: 5,
  file: new File(["notes"], "notes.md", { type: "text/markdown" }),
} satisfies ComposerFileAttachment;
const notesContextId = fileContextReference(notes).contextId;

function retention(): RetainedAttachmentContextPayloads {
  return { files: new Map(), previewAnnotations: new Map() };
}

describe("reconcileAttachmentContextReferences", () => {
  it("keeps a dropped file that never had an inline reference when the prompt changes", () => {
    const changes = reconcileAttachmentContextReferences({
      previousContextIds: new Set(),
      referencedContextIds: new Set(),
      files: [notes],
      images: [],
      previewAnnotations: [],
      retained: retention(),
    });
    expect(changes.filesToRemove).toEqual([]);
    expect(changes.filesToRestore).toEqual([]);
  });

  it("removes a file whose inline reference was deleted and restores it after undo", () => {
    const retained = retention();
    const removed = reconcileAttachmentContextReferences({
      previousContextIds: new Set([notesContextId]),
      referencedContextIds: new Set(),
      files: [notes],
      images: [],
      previewAnnotations: [],
      retained,
    });
    expect(removed.filesToRemove).toEqual(["file-1"]);

    const restored = reconcileAttachmentContextReferences({
      previousContextIds: new Set(),
      referencedContextIds: new Set([notesContextId]),
      files: [],
      images: [],
      previewAnnotations: [],
      retained,
    });
    expect(restored.filesToRestore).toEqual([notes]);
  });

  it("restores an annotation and its screenshot attachment after undo", () => {
    const retained = retention();
    const removed = reconcileAttachmentContextReferences({
      previousContextIds: new Set([previewAnnotationContextId(annotation.id)]),
      referencedContextIds: new Set(),
      files: [],
      images: [image],
      previewAnnotations: [annotation],
      retained,
    });
    expect(removed.annotationIdsToRemove).toEqual(["annotation-1"]);

    const restored = reconcileAttachmentContextReferences({
      previousContextIds: new Set(),
      referencedContextIds: new Set([previewAnnotationContextId(annotation.id)]),
      files: [],
      images: [],
      previewAnnotations: [],
      retained,
    });
    expect(restored.annotationsToRestore).toEqual([{ annotation, image }]);
    expect(restored.annotationsToRestore[0]?.annotation.screenshot?.dataUrl).toBe(
      "data:image/png;base64,YmluYXJ5",
    );
    expect(restored.annotationsToRestore[0]?.image?.file).toBe(binary);
    expect(
      buildMessageContext({
        terminalContexts: [],
        reviewComments: [],
        previewAnnotations: restored.annotationsToRestore.map((entry) => entry.annotation),
        attachments: [
          {
            attachment: restored.annotationsToRestore[0]!.image!,
            attachmentId: "uploaded-screenshot",
          },
        ],
      })?.records,
    ).toEqual([
      expect.objectContaining({
        kind: "preview-annotation",
        screenshotContextId: "image_annotation-1",
      }),
      expect.objectContaining({
        kind: "image",
        contextId: "image_annotation-1",
        attachmentId: "uploaded-screenshot",
      }),
    ]);
  });
});
