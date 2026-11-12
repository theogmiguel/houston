import { clampFileAttachmentUploadBytes } from "@houston-app/client-runtime/state/attachments";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { useState, type DragEvent } from "react";

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { planRowFileDrop } from "../../threads/rowFileDrop";
import { isFileTransfer } from "../../lib/fileTransfer";
import { randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import {
  composerFileAttachmentMimeType,
  fileAttachmentStagingLimit,
} from "../chat/composerAttachmentFiles";
import { toastManager } from "../ui/toast";

/**
 * Files dropped on a rail row join that thread's draft, so they go out with its next message
 * without opening the thread. The row shows `over` while files are above it.
 */
export function useRowFileDrop(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "title">,
) {
  const [over, setOver] = useState(false);

  const accepts = (event: DragEvent) => isFileTransfer(event.dataTransfer);

  return {
    over,
    handlers: {
      onDragEnter: (event: DragEvent) => {
        if (!accepts(event)) return;
        event.preventDefault();
        setOver(true);
      },
      onDragOver: (event: DragEvent) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      },
      onDragLeave: (event: DragEvent) => {
        // Moving onto a child of the row is not leaving it.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setOver(false);
      },
      onDrop: (event: DragEvent) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        const dropped = Array.from(event.dataTransfer.files);
        if (dropped.length === 0) return;

        const threadRef = scopeThreadRef(thread.environmentId, thread.id);
        const store = useComposerDraftStore.getState();
        const draft = store.getComposerDraft(threadRef);
        const config =
          appAtomRegistry.get(environmentServerConfigsAtom).get(thread.environmentId) ?? null;
        const advertised = config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null;
        const plan = planRowFileDrop(dropped, {
          fileLimitBytes: fileAttachmentStagingLimit({
            attachmentUploadsCapabilityKnown: config !== null,
            supportsAttachmentUploads: config !== null,
            maxFileAttachmentBytes:
              advertised === null ? null : clampFileAttachmentUploadBytes(advertised),
          }),
          heldCount: (draft?.images.length ?? 0) + (draft?.files.length ?? 0),
        });

        const files: ComposerFileAttachment[] = plan.files.map((file) => ({
          type: "file",
          id: randomUUID(),
          name: file.name || "file",
          mimeType: composerFileAttachmentMimeType(file),
          sizeBytes: file.size,
          file,
        }));
        const images: ComposerImageAttachment[] = plan.images.map((file) => ({
          type: "image",
          id: randomUUID(),
          name: file.name || "image",
          mimeType: file.type,
          sizeBytes: file.size,
          previewUrl: URL.createObjectURL(file),
          file,
        }));
        const storedFiles =
          files.length > 0 ? store.addFiles(threadRef, files, { appendReference: false }) : [];
        const storedImages =
          images.length > 0 ? new Set(store.addImages(threadRef, images)) : new Set<string>();
        for (const image of images) {
          if (!storedImages.has(image.id)) URL.revokeObjectURL(image.previewUrl);
        }

        const queued = storedFiles.length + storedImages.size;
        if (queued > 0) {
          toastManager.add({
            type: "info",
            title: `Added ${queued} ${queued === 1 ? "file" : "files"} to “${thread.title}”`,
            description: "They go out with that thread's next message.",
          });
        }
        if (plan.error !== null) toastManager.add({ type: "error", title: plan.error });
      },
    },
  };
}
