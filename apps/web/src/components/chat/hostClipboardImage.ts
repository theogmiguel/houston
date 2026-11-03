import type { HostClipboardImage } from "@houston-app/contracts";

/**
 * True when the paste holds an image the webview could not hand over as a file: WebKitGTK reports
 * an empty paste, and a browser's "Copy image" arrives as `text/html` wrapping an `<img>`.
 * Plain text, or rich text with visible content, stays with the editor.
 */
export function isClipboardImagePaste(clipboardData: DataTransfer): boolean {
  if (clipboardData.files.length > 0) return false;
  if (readClipboardText(clipboardData, "text/plain").trim().length > 0) return false;
  const html = readClipboardText(clipboardData, "text/html");
  return html.length === 0 || htmlIsOnlyAnImage(html);
}

/** Some engines throw for a flavor the paste does not advertise instead of returning "". */
function readClipboardText(clipboardData: DataTransfer, type: string): string {
  try {
    return clipboardData.getData(type) || "";
  } catch {
    return "";
  }
}

/** An image with no text around it, however the source app wraps it in markup. */
function htmlIsOnlyAnImage(html: string): boolean {
  if (!/<img\b/i.test(html)) return false;
  return html.replace(/<[^>]*>/g, "").trim().length === 0;
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
