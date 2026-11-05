import { PreviewCaptureFailure } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const noop = async () => undefined;
  const screenshot = {
    id: "screenshot-1",
    tabId: "tab-1",
    path: "screenshots/tab-1.png",
    mimeType: "image/png" as const,
    sizeBytes: 128,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const preview = {
    setForwardedShortcuts: vi.fn(noop),
    createTab: vi.fn(noop),
    closeTab: vi.fn(noop),
    registerWebview: vi.fn(noop),
    navigate: vi.fn(noop),
    goBack: vi.fn(noop),
    goForward: vi.fn(noop),
    refresh: vi.fn(noop),
    zoomIn: vi.fn(noop),
    zoomOut: vi.fn(noop),
    resetZoom: vi.fn(noop),
    setZoomFactor: vi.fn(noop),
    hardReload: vi.fn(noop),
    setColorScheme: vi.fn(noop),
    setAudioMuted: vi.fn(noop),
    openDevTools: vi.fn(noop),
    clearCookies: vi.fn(noop),
    clearCache: vi.fn(noop),
    getPreviewConfig: vi.fn(noop),
    listBrowserImportSources: vi.fn(noop),
    importBrowserCookies: vi.fn(noop),
    setAnnotationTheme: vi.fn(noop),
    setAnnotationSendEnabled: vi.fn(noop),
    pickElement: vi.fn(async () => null),
    cancelPickElement: vi.fn(noop),
    captureScreenshot: vi.fn(async () => screenshot),
    revealArtifact: vi.fn(noop),
    copyArtifactToClipboard: vi.fn(noop),
    pictureInPicture: {
      open: vi.fn(noop),
      close: vi.fn(noop),
    },
    recording: {
      onInput: vi.fn(() => () => {}),
      startScreencast: vi.fn(noop),
      stopScreencast: vi.fn(noop),
      save: vi.fn(noop),
    },
    onStateChange: vi.fn(() => () => {}),
    onPointerEvent: vi.fn(() => () => {}),
    onOpenLink: vi.fn(() => () => {}),
  };
  window.hostBridge = { preview } as never;
  return { preview, screenshot };
});

import { previewBridge } from "./previewBridge";

describe("previewBridge", () => {
  it("installs the host preview bridge and delegates every control", async () => {
    expect(previewBridge).not.toBeNull();
    const bridge = previewBridge!;

    await bridge.createTab("tab-1");
    await bridge.closeTab("tab-1");
    await bridge.registerWebview("tab-1", 42);
    await bridge.navigate("tab-1", "http://example.com/");
    await bridge.goBack("tab-1");
    await bridge.goForward("tab-1");
    await bridge.refresh("tab-1");
    await bridge.hardReload("tab-1");
    await bridge.zoomIn("tab-1");
    await bridge.zoomOut("tab-1");
    await bridge.resetZoom("tab-1");
    await bridge.setZoomFactor("tab-1", 1.5);
    await bridge.setColorScheme("tab-1", "dark");
    await bridge.setAudioMuted("tab-1", true);
    await bridge.openDevTools("tab-1");
    await bridge.clearCookies("environment-1" as never);
    await bridge.clearCache("environment-1" as never);
    await bridge.pickElement("tab-1");
    await bridge.setAnnotationSendEnabled("tab-1", true);
    await bridge.cancelPickElement("tab-1");
    await bridge.pictureInPicture.open("tab-1");
    await bridge.pictureInPicture.close("tab-1");
    await bridge.recording.startScreencast("tab-1");
    await bridge.recording.stopScreencast("tab-1");

    expect(mocks.preview.createTab).toHaveBeenCalledWith("tab-1");
    expect(mocks.preview.navigate).toHaveBeenCalledWith("tab-1", "http://example.com/");
    expect(mocks.preview.goBack).toHaveBeenCalledWith("tab-1");
    expect(mocks.preview.goForward).toHaveBeenCalledWith("tab-1");
    expect(mocks.preview.refresh).toHaveBeenCalledWith("tab-1");
    expect(mocks.preview.hardReload).toHaveBeenCalledWith("tab-1");
    expect(mocks.preview.zoomIn).toHaveBeenCalledWith("tab-1");
    expect(mocks.preview.zoomOut).toHaveBeenCalledWith("tab-1");
    expect(mocks.preview.resetZoom).toHaveBeenCalledWith("tab-1");
    expect(mocks.preview.setZoomFactor).toHaveBeenCalledWith("tab-1", 1.5);
    expect(mocks.preview.setColorScheme).toHaveBeenCalledWith("tab-1", "dark");
    expect(mocks.preview.setAudioMuted).toHaveBeenCalledWith("tab-1", true);
    expect(mocks.preview.openDevTools).toHaveBeenCalledWith("tab-1");
    expect(mocks.preview.clearCookies).toHaveBeenCalledWith("environment-1");
    expect(mocks.preview.clearCache).toHaveBeenCalledWith("environment-1");
    expect(mocks.preview.pickElement).toHaveBeenCalledWith("tab-1");
    expect(mocks.preview.cancelPickElement).toHaveBeenCalledWith("tab-1");
    expect(mocks.preview.pictureInPicture.open).toHaveBeenCalledWith("tab-1");
    expect(mocks.preview.pictureInPicture.close).toHaveBeenCalledWith("tab-1");
    expect(mocks.preview.recording.startScreencast).toHaveBeenCalledWith("tab-1");
    expect(mocks.preview.recording.stopScreencast).toHaveBeenCalledWith("tab-1");
  });

  it("returns the screenshot artifact from the host", async () => {
    const artifact = await previewBridge!.captureScreenshot("tab-1");
    expect(mocks.preview.captureScreenshot).toHaveBeenCalledWith("tab-1");
    expect(artifact).toEqual(mocks.screenshot);
  });

  it("turns an encoded host capture failure into a thrown error", async () => {
    mocks.preview.captureScreenshot.mockResolvedValueOnce({
      _tag: "PreviewCaptureFailure",
      reason: "capture-failed",
      stage: "screenshot",
    } as never);

    await expect(previewBridge!.captureScreenshot("tab-1")).rejects.toBeInstanceOf(
      PreviewCaptureFailure,
    );
  });
});
