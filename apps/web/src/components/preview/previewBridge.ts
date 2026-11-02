import type { DesktopPreviewScreenshotArtifact, HostPreviewBridge } from "@houston-app/contracts";

type UnwrappedPreviewBridge = Omit<HostPreviewBridge, "captureScreenshot" | "recording"> & {
  captureScreenshot: (tabId: string) => Promise<DesktopPreviewScreenshotArtifact>;
  recording: Omit<HostPreviewBridge["recording"], "startScreencast"> & {
    startScreencast: (tabId: string) => Promise<void>;
  };
};

// The desktop host renders preview tabs through the server stream and installs no native
// preview bridge.
export const previewBridge: UnwrappedPreviewBridge | null = null;
