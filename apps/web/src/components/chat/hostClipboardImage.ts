import type { HostClipboardImage } from "@houston-app/contracts";

/**
 * A paste whose `clipboardData` names no files and no text. WebKitGTK reports a clipboard image
 * this way: no types, no files. A paste that carries any text type stays with the editor.
 */
export function isEmptyPaste(clipboardData: DataTransfer): boolean {
  return (
    clipboardData.files.length === 0 &&
    !clipboardData.types.includes("text/plain") &&
    !clipboardData.types.includes("text/html")
  );
}

const EXTENSION_BY_MEDIA_TYPE: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Reads the host clipboard image as a `File`, or null when the clipboard holds none. */
export async function readHostClipboardImageFile(
  read: () => Promise<HostClipboardImage | null>,
): Promise<File | null> {
  const image = await read();
  if (image === null) return null;
  const extension = EXTENSION_BY_MEDIA_TYPE[image.mediaType];
  if (extension === undefined) {
    throw new Error(
      `Host clipboard image has media type ${JSON.stringify(image.mediaType)}; expected one of ${Object.keys(EXTENSION_BY_MEDIA_TYPE).join(", ")}`,
    );
  }
  let binary: string;
  try {
    binary = atob(image.base64);
  } catch (cause) {
    throw new Error(
      `Host clipboard image is not valid base64 (${image.base64.length} characters, expected standard base64)`,
      { cause },
    );
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new File([bytes], `pasted-image.${extension}`, { type: image.mediaType });
}
