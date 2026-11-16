import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@houston-app/contracts";
import { fileAttachmentTooLargeMessage } from "@houston-app/client-runtime/state/attachments";

import {
  classifyComposerAttachmentFile,
  normalizeComposerImageFileMimeType,
} from "../components/chat/composerAttachmentFiles";

export interface RowFileDropPlan {
  readonly files: ReadonlyArray<File>;
  readonly images: ReadonlyArray<File>;
  /** What the drop could not queue, naming the file and the limit; the last refusal wins. */
  readonly error: string | null;
}

/**
 * Which dropped files a thread's draft can take. The row has no composer to compress an image, so
 * an image over the send limit is refused rather than shrunk; the composer itself still shrinks it.
 */
export function planRowFileDrop(
  dropped: ReadonlyArray<File>,
  input: {
    /** Null when the environment does not take file attachments. */
    readonly fileLimitBytes: number | null;
    /** Attachments the draft already holds. */
    readonly heldCount: number;
  },
): RowFileDropPlan {
  const files: File[] = [];
  const images: File[] = [];
  let error: string | null = null;
  let count = input.heldCount;
  for (const file of dropped) {
    if (count >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      error = `A message holds up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments; this thread's draft is full.`;
      continue;
    }
    const kind = classifyComposerAttachmentFile(file);
    if (kind === "unsupported-image") {
      error = `'${file.name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`;
      continue;
    }
    if (kind === "image") {
      if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        error = fileAttachmentTooLargeMessage(file.name, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
        continue;
      }
      images.push(normalizeComposerImageFileMimeType(file));
    } else {
      if (input.fileLimitBytes === null) {
        error = "This environment does not support file attachments.";
        continue;
      }
      if (file.size <= 0) {
        error = `'${file.name}' is empty or could not be read.`;
        continue;
      }
      if (file.size > input.fileLimitBytes) {
        error = fileAttachmentTooLargeMessage(file.name, input.fileLimitBytes);
        continue;
      }
      files.push(file);
    }
    count += 1;
  }
  return { files, images, error };
}
