import { useEffect, useRef, useState, type ComponentProps, type SyntheticEvent } from "react";
import { isHeicImageFile } from "../../lib/imageCompression";

type AttachmentImageProps = ComponentProps<"img"> & { name: string; mimeType?: string | undefined };

// Keep import expressions outside hooks until React Compiler supports them.
const loadImageDecoder = () => import("../files/decodeImagePreview");

const TIFF_SUFFIX = /\.tiff?$/i;
const TIFF_MIME_TYPE = /^image\/tiff$/i;

export function AttachmentImage({ name, mimeType, ...props }: AttachmentImageProps) {
  const fallback =
    isHeicImageFile({ name, type: mimeType ?? "" }) ||
    TIFF_SUFFIX.test(name) ||
    TIFF_MIME_TYPE.test(mimeType ?? "");
  return fallback ? (
    <DecodedImage key={props.src} {...props} name={name} mimeType={mimeType} />
  ) : (
    <img {...props} />
  );
}

type DecodeAttempt = { readonly controller: AbortController; objectUrl?: string };

const HEIC_SUFFIX = /\.hei[cf]$/i;
const HEIC_MIME_TYPE = /^image\/hei[cf]$/i;

function DecodedImage({ name, mimeType, src, onError, ...props }: AttachmentImageProps) {
  const [previewUrl, setPreviewUrl] = useState<string>();
  // One decode per mount; the parent keys this component by src.
  const decodeRef = useRef<DecodeAttempt | null>(null);

  // The browser cannot show HEIC or TIFF itself, so its load error starts the decode.
  const decode = (event: SyntheticEvent<HTMLImageElement>) => {
    if (decodeRef.current !== null || !src) return onError?.(event);
    const attempt: DecodeAttempt = { controller: new AbortController() };
    decodeRef.current = attempt;
    const { signal } = attempt.controller;
    void loadImageDecoder()
      .then(async ({ decodeImagePreview }) => {
        if (signal.aborted) return;
        const blob = await decodeImagePreview(
          src,
          HEIC_SUFFIX.test(name) || HEIC_MIME_TYPE.test(mimeType ?? ""),
          signal,
        );
        if (signal.aborted) return;
        attempt.objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(attempt.objectUrl);
      })
      .catch(() => {
        if (!signal.aborted) onError?.(event);
      });
  };

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- the async decode and its blob URL live as long as this component
  useEffect(
    () => () => {
      const attempt = decodeRef.current;
      if (attempt === null) return;
      attempt.controller.abort();
      if (attempt.objectUrl) URL.revokeObjectURL(attempt.objectUrl);
    },
    [],
  );

  return <img {...props} src={previewUrl ?? src} onError={decode} />;
}
