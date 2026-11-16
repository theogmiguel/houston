import { EnvironmentId } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  awaitAttachmentUploads: vi.fn(),
  getUploadedAttachments: vi.fn(),
}));

vi.mock("../../lib/attachmentUploadQueue", () => ({
  awaitAttachmentUploads: mocks.awaitAttachmentUploads,
  getUploadedAttachments: mocks.getUploadedAttachments,
}));

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { prepareTurnAttachments } from "./chatViewSend";

const environmentId = EnvironmentId.make("local");
const image = { type: "image", id: "img-1", name: "shot.png" } as ComposerImageAttachment;
const uploaded = { type: "image", id: "img-1", name: "shot.png" };

describe("prepareTurnAttachments", () => {
  it("reads an upload record only after the upload has settled", async () => {
    const order: string[] = [];
    mocks.awaitAttachmentUploads.mockImplementation(async () => {
      order.push("await");
    });
    mocks.getUploadedAttachments.mockImplementation(() => {
      order.push("read");
      return [uploaded];
    });
    await expect(
      prepareTurnAttachments({ environmentId, attachments: [image], usesAttachmentUploads: true }),
    ).resolves.toEqual([uploaded]);
    expect(order).toEqual(["await", "read"]);
    expect(mocks.awaitAttachmentUploads).toHaveBeenCalledWith(["img-1"]);
  });

  it("names the attachment that failed to upload", async () => {
    mocks.awaitAttachmentUploads.mockResolvedValue(undefined);
    mocks.getUploadedAttachments.mockReturnValue(null);
    await expect(
      prepareTurnAttachments({ environmentId, attachments: [image], usesAttachmentUploads: true }),
    ).rejects.toThrow("Attachment 'shot.png' failed to upload.");
  });
});
