import { PreviewCaptureFailure, type PreviewCaptureFailureEncoded } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { hasNativeBrowserHost } from "~/env";

const decodeCaptureFailure = Schema.decodeUnknownOption(PreviewCaptureFailure);

// Decode here because contextBridge strips custom properties from rejected Errors.
function unwrapPreviewCaptureResult<A>(result: A | PreviewCaptureFailureEncoded): A {
  const failure = decodeCaptureFailure(result);
  if (Option.isSome(failure)) throw failure.value;
  return result as A;
}

// The Tauri shim advertises preview members as no-ops; there the tab is a server stream.
const nativePreviewBridge =
  typeof window === "undefined" || !hasNativeBrowserHost
    ? null
    : (window.desktopBridge?.preview ?? null);

export const previewBridge = nativePreviewBridge
  ? {
      ...nativePreviewBridge,
      captureScreenshot: async (tabId: string) =>
        unwrapPreviewCaptureResult(await nativePreviewBridge.captureScreenshot(tabId)),
      recording: {
        ...nativePreviewBridge.recording,
        startScreencast: async (tabId: string) =>
          unwrapPreviewCaptureResult(await nativePreviewBridge.recording.startScreencast(tabId)),
      },
    }
  : null;
