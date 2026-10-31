import type {
  ChatAttachment,
  ChatFileAttachment,
  EnvironmentId,
  ScopedThreadRef,
  SnapShotSource,
} from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { CircleAlertIcon, PlayIcon, PlusIcon, XIcon } from "lucide-react";
import { type ComponentProps, useLayoutEffect, useRef } from "react";

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftId,
  composerFileNeedsReattach,
} from "../../composerDraftStore";
import { retryAttachmentUpload, useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";
import { formatAttachmentUploadProgress } from "../../lib/attachmentUploadState";
import { isHeicImageFile } from "../../lib/imageCompression";
import {
  type PendingSnapShotAnimation,
  scheduleSnapShotAnimationDestination,
  setSnapShotAnimationDestination,
  shouldAnimateSnapShotArrival,
} from "../../lib/snapShotAnimation";
import { cn } from "~/lib/utils";
import { useTheme } from "~/hooks/useTheme";
import { getRestingComposerImagePreviewCounts } from "../composerFooterLayout";
import { AttachmentFilePreview } from "../files/AttachmentFilePreview";
import { AttachmentImage } from "../media/AttachmentImage";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerImageThumbnail } from "./ComposerImageThumbnail";
import { composerFloatingLayerProps } from "./composerEventScope";
import type { PreparingComposerImage } from "./preparingComposerImages";
import {
  attachVideoThumbnail,
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { PierreEntryIcon } from "./PierreEntryIcon";
import {
  SNAP_SHOT_ATTACHMENT_FRAME_CLASS,
  SnapShotAttachmentDetails,
} from "./SnapShotAttachmentDetails";
import { prepareVideoFirstFrame } from "../../lib/videoFirstFrame";

const ATTACHMENT_TILE_CLASS =
  "group/tile relative size-14 shrink-0 snap-start overflow-hidden rounded-lg";

function attachmentUploadRatio(progress: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
}

/** Board tile progress: a 56px ring tracing the upload plus its percentage. */
function AttachmentUploadRing(props: { progress: number; overImage?: boolean }) {
  return (
    <>
      <svg
        aria-hidden="true"
        viewBox="0 0 56 56"
        className="pointer-events-none absolute -top-px -left-px size-14"
      >
        <rect
          x="0.75"
          y="0.75"
          width="54.5"
          height="54.5"
          rx="9"
          pathLength={100}
          fill="none"
          stroke="var(--accent-ink)"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray={`${attachmentUploadRatio(props.progress) * 100} 100`}
        />
      </svg>
      <span
        className={cn(
          "pointer-events-none absolute top-[5px] right-[5px] text-4xs font-semibold text-(--accent-ink) leading-2.5 tabular-nums",
          props.overImage && "rounded-(--r-badge) bg-black/50 px-1 py-px text-white",
        )}
      >
        {formatAttachmentUploadProgress(props.progress)}
      </span>
    </>
  );
}

function AttachmentTileRemoveButton(props: {
  name: string;
  overImage?: boolean;
  onRemove: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`Remove ${props.name}`}
      onClick={(event) => {
        event.stopPropagation();
        props.onRemove();
      }}
      className={cn(
        "absolute top-1 right-1 z-10 grid size-4 place-items-center rounded-full opacity-0 transition-opacity group-hover/tile:opacity-100 group-focus-within/tile:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
        props.overImage
          ? "bg-black/50 text-white hover:bg-black/70"
          : "text-(--t3) hover:bg-(--hover) hover:text-(--t1)",
      )}
    >
      <XIcon aria-hidden="true" className="size-[11px]" />
    </button>
  );
}

function AttachmentTileRetryButton(props: {
  name: string;
  reason: string;
  disabled: boolean;
  onRetry: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Retry upload for ${props.name}`}
            disabled={props.disabled}
            onClick={(event) => {
              event.stopPropagation();
              props.onRetry();
            }}
            className="grid size-[18px] place-items-center text-(--warn) outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default disabled:opacity-60"
          />
        }
      >
        <CircleAlertIcon aria-hidden="true" className="size-[18px]" />
      </TooltipTrigger>
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

function ComposerVideoThumbnail({ file }: { file: File }) {
  const setVideo = (video: HTMLVideoElement | null) => {
    if (!video) return;
    return attachVideoThumbnail(video, file);
  };

  return (
    <video
      ref={setVideo}
      muted
      playsInline
      preload="metadata"
      aria-hidden="true"
      onLoadedMetadata={(event) => prepareVideoFirstFrame(event.currentTarget)}
      className="pointer-events-none absolute inset-0 size-full object-cover"
    />
  );
}

function SnapShotAttachmentFrame({
  animationId,
  animationSource,
  arrival,
  animateArrival,
  className,
  ...props
}: ComponentProps<"div"> & {
  readonly animationId?: string | undefined;
  readonly animationSource?: SnapShotSource | undefined;
  readonly arrival?: boolean | undefined;
  readonly animateArrival?: boolean | undefined;
}) {
  const frameRef = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the mounted tile into view and registers it as the SnapShot animation destination
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame || (!animationId && !arrival)) return;
    frame.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (!animationId) return;

    return scheduleSnapShotAnimationDestination(animationId, () =>
      setSnapShotAnimationDestination(animationId, frame, animationSource),
    );
  }, [animationId, animationSource, arrival]);

  return (
    <div
      ref={frameRef}
      className={cn(
        animateArrival &&
          !animationId &&
          "origin-center transition-[opacity,scale] duration-300 ease-drawer starting:scale-95 starting:opacity-0 motion-reduce:transition-none motion-reduce:starting:scale-100 motion-reduce:starting:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

/** Image, SnapShot and video tiles above the composer editor. */
export function ComposerAttachmentMediaRow({
  images,
  expandedImages,
  preparingImages,
  videos,
  pendingSnapShotAnimations,
  pendingSnapShotIds,
  uncommittedSnapShotIds,
  nonPersistedImageIds,
  snapShotAnimations,
  supportsAttachmentUploads,
  maxFileAttachmentBytes,
  environmentId,
  attachmentDraftTarget,
  canOperateThread,
  onExpandImage,
  onFileOpen,
  onRemoveImage,
  onRemoveFile,
}: {
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly expandedImages: ReadonlyArray<ComposerImageAttachment>;
  readonly preparingImages: ReadonlyArray<PreparingComposerImage>;
  readonly videos: ReadonlyArray<ComposerFileAttachment>;
  readonly pendingSnapShotAnimations: ReadonlyArray<PendingSnapShotAnimation>;
  readonly pendingSnapShotIds: ReadonlyArray<string>;
  readonly uncommittedSnapShotIds: ReadonlyArray<string>;
  readonly nonPersistedImageIds: ReadonlyArray<string>;
  readonly snapShotAnimations: boolean;
  readonly supportsAttachmentUploads: boolean;
  readonly maxFileAttachmentBytes: number | null;
  readonly environmentId: EnvironmentId;
  readonly attachmentDraftTarget: ScopedThreadRef | DraftId;
  readonly canOperateThread: boolean;
  readonly onExpandImage: (preview: ExpandedImagePreview) => void;
  readonly onFileOpen: (attachment: ChatFileAttachment) => void;
  readonly onRemoveImage: (imageId: string) => void;
  readonly onRemoveFile: (fileId: string) => void;
}) {
  const uploadsByImageId = useAttachmentUploadStore((state) => state.uploadsByImageId);
  const pendingSnapShotIdSet = new Set(pendingSnapShotIds);
  const nonPersistedImageIdSet = new Set(nonPersistedImageIds);
  return (
    <div
      className={cn(
        "mb-2 flex max-w-full gap-1.5",
        pendingSnapShotIds.length > 0 ||
          expandedImages.some((image) => image.source?.kind === "snap-shot")
          ? "snap-x snap-proximity overflow-x-auto overscroll-x-contain pb-1 scrollbar-thumb-foreground/18 scrollbar-track-transparent [scrollbar-width:thin] [&::-webkit-scrollbar]:h-2.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:border-3 [&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-foreground/18 [&::-webkit-scrollbar-thumb]:bg-clip-content [&::-webkit-scrollbar-thumb:hover]:bg-foreground/28 [&::-webkit-scrollbar-track]:mx-1 [&::-webkit-scrollbar-track]:bg-transparent"
          : "flex-wrap",
      )}
    >
      {/* A preparing image renders through the same tile, keyed by the id its compressed image
          takes, so the thumbnail element survives the swap. */}
      {[
        ...expandedImages.map((image) => ({ image, ready: image })),
        ...preparingImages.map((image) => ({ image, ready: null })),
      ]
        .map(({ image, ready }) => {
          const upload =
            ready && supportsAttachmentUploads ? uploadsByImageId[image.id] : undefined;
          const source = ready?.source;
          const isSnapShot = source !== undefined;
          const snapShotAnimationPending = isSnapShot && pendingSnapShotIdSet.has(image.id);
          const snapShotArrival = isSnapShot && shouldAnimateSnapShotArrival(source.capturedAt);
          const uploadFailed = ready !== null && upload?.status === "failed";
          return (
            <SnapShotAttachmentFrame
              key={image.id}
              data-chat-composer-expanded-image="true"
              aria-hidden={snapShotAnimationPending || undefined}
              inert={snapShotAnimationPending || undefined}
              arrival={snapShotArrival}
              animateArrival={snapShotAnimations && !snapShotAnimationPending && snapShotArrival}
              animationId={snapShotAnimationPending ? image.id : undefined}
              animationSource={snapShotAnimationPending ? source : undefined}
              className={cn(
                "group/tile shrink-0 snap-start bg-(--field)",
                isSnapShot
                  ? SNAP_SHOT_ATTACHMENT_FRAME_CLASS
                  : "relative size-14 overflow-hidden rounded-lg border border-transparent",
                uploadFailed && "border-(--warn-line)",
                snapShotAnimationPending && "invisible",
              )}
            >
              {!ready || ready.previewUrl ? (
                <button
                  type="button"
                  className={cn("h-full w-full", ready && "cursor-zoom-in")}
                  aria-label={`Preview ${image.name}`}
                  disabled={!ready}
                  onClick={() => {
                    const preview = buildExpandedImagePreview(images, image.id);
                    if (!preview) return;
                    onExpandImage(preview);
                  }}
                >
                  <ComposerImageThumbnail
                    file={image.file}
                    alt={image.name}
                    className="h-full w-full object-cover"
                    fallback={
                      ready && isHeicImageFile({ name: ready.name, type: ready.mimeType }) ? (
                        <AttachmentImage
                          name={ready.name}
                          mimeType={ready.mimeType}
                          src={ready.previewUrl}
                          alt={image.name}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span className="flex h-full items-center justify-center px-1 text-3xs text-secondary-label">
                          {image.name}
                        </span>
                      )
                    }
                  />
                </button>
              ) : (
                <div className="flex h-full w-full items-center justify-center px-1 text-center text-3xs text-secondary-label">
                  {image.name}
                </div>
              )}
              {isSnapShot ? (
                <SnapShotAttachmentDetails
                  source={source}
                  className={cn(
                    upload?.status === "uploading" && "bottom-4",
                    upload?.status === "failed" && "bottom-8",
                  )}
                />
              ) : null}
              {nonPersistedImageIdSet.has(image.id) && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        role="img"
                        aria-label="Draft attachment may not persist"
                        className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-warning-foreground"
                      >
                        <CircleAlertIcon className="size-3" />
                      </span>
                    }
                  />
                  <TooltipPopup side="top">
                    Draft attachment could not be saved locally and may be lost on navigation.
                  </TooltipPopup>
                </Tooltip>
              )}
              {upload?.status === "uploading" && (
                <AttachmentUploadRing progress={upload.progress} overImage />
              )}
              {uploadFailed && (
                <span className="absolute top-[6px] left-[6px] z-10 inline-flex rounded bg-black/45 p-0.5">
                  <AttachmentTileRetryButton
                    name={image.name}
                    reason={upload.reason}
                    disabled={!canOperateThread}
                    onRetry={() =>
                      retryAttachmentUpload({
                        environmentId,
                        image: ready,
                        draftTarget: attachmentDraftTarget,
                      })
                    }
                  />
                </span>
              )}
              <AttachmentTileRemoveButton
                name={image.name}
                overImage
                onRemove={() => onRemoveImage(image.id)}
              />
            </SnapShotAttachmentFrame>
          );
        })
        .concat(
          uncommittedSnapShotIds.map((captureId) => (
            <SnapShotAttachmentFrame
              key={captureId}
              aria-hidden="true"
              animationId={captureId}
              animationSource={
                pendingSnapShotAnimations.find((capture) => capture.id === captureId)?.source
              }
              className={cn(
                SNAP_SHOT_ATTACHMENT_FRAME_CLASS,
                "invisible shrink-0 snap-start bg-background",
              )}
            />
          )),
        )}
      {videos.map((file) => {
        const fileCanUpload =
          supportsAttachmentUploads &&
          maxFileAttachmentBytes !== null &&
          file.sizeBytes <= maxFileAttachmentBytes;
        const upload = fileCanUpload ? uploadsByImageId[file.id] : undefined;
        const uploadFailed = upload?.status === "failed";
        return (
          <div
            key={file.id}
            className={cn(
              ATTACHMENT_TILE_CLASS,
              "border border-transparent bg-black",
              uploadFailed && "border-(--warn-line)",
            )}
          >
            <button
              type="button"
              className="flex h-full w-full cursor-zoom-in flex-col items-center justify-center gap-1 px-1 text-white"
              aria-label={`Play ${file.name}`}
              onClick={() => {
                if (file.file !== null) {
                  const preview = buildExpandedImagePreview([file], file.id);
                  if (preview) onExpandImage(preview);
                  return;
                }
                if (!file.uploadedAttachmentId) return;
                onFileOpen({ ...file, id: file.uploadedAttachmentId });
              }}
            >
              {file.file && (
                <>
                  <ComposerVideoThumbnail file={file.file} />
                  <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-black/10" />
                </>
              )}
              <PlayIcon className="relative z-10 size-4 fill-current drop-shadow-md" />
            </button>
            {upload?.status === "uploading" && (
              <AttachmentUploadRing progress={upload.progress} overImage />
            )}
            {uploadFailed && (
              <span className="absolute top-[6px] left-[6px] z-10 inline-flex rounded bg-black/45 p-0.5">
                <AttachmentTileRetryButton
                  name={file.name}
                  reason={upload.reason}
                  disabled={!canOperateThread}
                  onRetry={() =>
                    retryAttachmentUpload({
                      environmentId,
                      image: file,
                      draftTarget: attachmentDraftTarget,
                    })
                  }
                />
              </span>
            )}
            <AttachmentTileRemoveButton
              name={file.name}
              overImage
              onRemove={() => onRemoveFile(file.id)}
            />
          </div>
        );
      })}
    </div>
  );
}

/** Non-media file attachments, listed under the media row. */
export function ComposerAttachmentFileList({
  files,
  resolvedTheme,
  supportsAttachmentUploads,
  maxFileAttachmentBytes,
  fileStagingLimit,
  environmentId,
  attachmentDraftTarget,
  canOperateThread,
  onPreviewFile,
  onRemoveFile,
}: {
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly resolvedTheme: "light" | "dark";
  readonly supportsAttachmentUploads: boolean;
  readonly maxFileAttachmentBytes: number | null;
  readonly fileStagingLimit: number | null;
  readonly environmentId: EnvironmentId;
  readonly attachmentDraftTarget: ScopedThreadRef | DraftId;
  readonly canOperateThread: boolean;
  readonly onPreviewFile: (fileId: string) => void;
  readonly onRemoveFile: (fileId: string) => void;
}) {
  const uploadsByImageId = useAttachmentUploadStore((state) => state.uploadsByImageId);
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {files.map((file) => {
        const fileCanUpload =
          supportsAttachmentUploads &&
          maxFileAttachmentBytes !== null &&
          file.sizeBytes <= maxFileAttachmentBytes;
        const upload = fileCanUpload ? uploadsByImageId[file.id] : undefined;
        const needsReattach = composerFileNeedsReattach(file);
        const canReattachFile = fileStagingLimit !== null && file.sizeBytes <= fileStagingLimit;
        const uploadFailed = !needsReattach && upload?.status === "failed";
        const tooltip = needsReattach
          ? canReattachFile
            ? `${file.name} was not saved with this draft. Attach it again to send it.`
            : `${file.name} was not saved with this draft. Remove it to send.`
          : upload?.status === "failed"
            ? upload.reason
            : `${file.name}\n${formatAttachmentSize(file.sizeBytes)}`;
        return (
          <div
            key={file.id}
            className={cn(
              ATTACHMENT_TILE_CLASS,
              "border border-(--border) bg-(--field)",
              needsReattach && "border-dashed opacity-60",
              uploadFailed && "border-(--warn-line)",
            )}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    disabled={needsReattach}
                    className="absolute inset-0 flex flex-col justify-between p-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default"
                    aria-label={
                      needsReattach
                        ? `${file.name}, ${canReattachFile ? "attach again" : "remove to send"}`
                        : `Preview ${file.name}`
                    }
                    onClick={() => onPreviewFile(file.id)}
                  >
                    <PierreEntryIcon
                      pathValue={file.name}
                      kind="file"
                      theme={resolvedTheme}
                      className="size-[18px]"
                    />
                    <span className="w-full truncate text-3xs text-(--t3) leading-3">
                      {file.name}
                    </span>
                  </button>
                }
              />
              <TooltipPopup side="top" className="whitespace-pre-wrap">
                {tooltip}
              </TooltipPopup>
            </Tooltip>
            {upload?.status === "uploading" && <AttachmentUploadRing progress={upload.progress} />}
            {uploadFailed && (
              <span className="absolute top-[6px] left-[5px] z-10 inline-flex">
                <AttachmentTileRetryButton
                  name={file.name}
                  reason={upload.reason}
                  disabled={!canOperateThread}
                  onRetry={() =>
                    retryAttachmentUpload({
                      environmentId,
                      image: file,
                      draftTarget: attachmentDraftTarget,
                    })
                  }
                />
              </span>
            )}
            <AttachmentTileRemoveButton name={file.name} onRemove={() => onRemoveFile(file.id)} />
          </div>
        );
      })}
    </div>
  );
}

export function ComposerFilePreviewDialog({
  file,
  onRemove,
  onPreviewFileIdChange,
}: {
  readonly file: ComposerFileAttachment;
  readonly onRemove: (fileId: string) => void;
  readonly onPreviewFileIdChange: (fileId: string | null) => void;
}) {
  const onClose = () => onPreviewFileIdChange(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        {...composerFloatingLayerProps}
        className="h-[min(85vh,52rem)] max-w-4xl overflow-hidden"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{file.name}</DialogTitle>
        <AttachmentFilePreview
          key={file.id}
          name={file.name}
          mimeType={file.mimeType}
          sizeBytes={file.sizeBytes}
          file={file.file}
          origin="Draft"
          {...(file.uploadedAttachmentId && file.uploadEnvironmentId
            ? {
                asset: {
                  environmentId: file.uploadEnvironmentId,
                  attachmentId: file.uploadedAttachmentId,
                },
              }
            : {})}
          onRemove={() => {
            onRemove(file.id);
            onClose();
          }}
          onClose={onClose}
        />
      </DialogPopup>
    </Dialog>
  );
}

/** Thumbnails beside the single-line prompt while the composer rests. */
export function ComposerRestingImagePreviews({
  images,
  allImages,
  resolvedTheme,
  onExpandImage,
  onShowMore,
}: {
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly allImages: ReadonlyArray<ComposerImageAttachment>;
  readonly resolvedTheme: "light" | "dark";
  readonly onExpandImage: (preview: ExpandedImagePreview) => void;
  readonly onShowMore: () => void;
}) {
  const counts = getRestingComposerImagePreviewCounts(images.length);
  const visibleImages = images.slice(0, counts.visibleCount);
  return (
    <div data-chat-composer-resting-images="true" className="flex shrink-0 items-center gap-1 ps-1">
      {visibleImages.map((image) => (
        <button
          key={image.id}
          type="button"
          className="relative size-7 shrink-0 cursor-zoom-in overflow-hidden rounded-md border border-border/70 bg-muted/60"
          aria-label={`Preview ${image.name}`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            const preview = buildExpandedImagePreview(allImages, image.id);
            if (preview) onExpandImage(preview);
          }}
        >
          {image.previewUrl ? (
            <ComposerImageThumbnail
              file={image.file}
              alt=""
              className="size-full object-cover"
              fallback={
                isHeicImageFile({ name: image.name, type: image.mimeType }) ? (
                  <AttachmentImage
                    name={image.name}
                    mimeType={image.mimeType}
                    src={image.previewUrl}
                    alt=""
                    className="size-full object-cover"
                  />
                ) : (
                  <PierreEntryIcon
                    pathValue={image.name}
                    kind="file"
                    theme={resolvedTheme}
                    className="m-auto size-3.5"
                  />
                )
              }
            />
          ) : (
            <PierreEntryIcon
              pathValue={image.name}
              kind="file"
              theme={resolvedTheme}
              className="m-auto size-3.5"
            />
          )}
        </button>
      ))}
      {counts.overflowCount > 0 ? (
        <button
          type="button"
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border/70 bg-muted/60 font-medium text-secondary-label text-xs tabular-nums outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          aria-label={`Show ${String(counts.overflowCount)} more image attachments`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={onShowMore}
        >
          +{counts.overflowCount}
        </button>
      ) : null}
    </div>
  );
}

/** Attachments of the queued message being edited; they are already uploaded. */
export function ComposerQueuedAttachmentRow({
  attachments,
  onRemove,
}: {
  readonly attachments: ReadonlyArray<{
    readonly attachment: ChatAttachment;
    readonly url: string | null;
  }>;
  readonly onRemove: (attachmentId: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {attachments.map(({ attachment, url }) => {
        const isImage = attachment.type === "image" && url !== null;
        return (
          <div
            key={attachment.id}
            className={cn(
              ATTACHMENT_TILE_CLASS,
              "border border-(--border) border-dashed bg-(--field) opacity-60",
            )}
          >
            {isImage ? (
              <img src={url} alt={attachment.name} className="h-full w-full object-cover" />
            ) : (
              <div className="absolute inset-0 flex flex-col justify-between p-1.5">
                <PierreEntryIcon
                  pathValue={attachment.name}
                  kind="file"
                  theme={resolvedTheme}
                  className="size-[18px]"
                />
                <span className="w-full truncate text-3xs text-(--t3) leading-3">
                  {attachment.name}
                </span>
              </div>
            )}
            <AttachmentTileRemoveButton
              name={attachment.name}
              overImage={isImage}
              onRemove={() => onRemove(attachment.id)}
            />
          </div>
        );
      })}
    </div>
  );
}

export function ComposerAttachButton({
  addComposerAttachments,
  focusComposer,
}: {
  readonly addComposerAttachments: (files: File[]) => Promise<boolean>;
  readonly focusComposer: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          // Inserting a chip refocuses the editor after the draft renders;
          // focusing synchronously here would report the editor's stale text
          // over the prompt that was just written.
          void addComposerAttachments(files).then((inserted) => {
            if (!inserted) focusComposer();
          });
        }}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => inputRef.current?.click()}
              aria-label="Attach files"
            />
          }
        >
          <PlusIcon />
        </TooltipTrigger>
        <TooltipPopup>Attach files</TooltipPopup>
      </Tooltip>
    </>
  );
}
