import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

const mocks = vi.hoisted(() => {
  const navigate = vi.fn(async (_tabId: string, _url: string): Promise<void> => undefined);
  const goBack = vi.fn(async (_tabId: string): Promise<void> => undefined);
  const goForward = vi.fn(async (_tabId: string): Promise<void> => undefined);
  const refresh = vi.fn(async (_tabId: string): Promise<void> => undefined);
  const hardReload = vi.fn(async (_tabId: string): Promise<void> => undefined);
  const openDevTools = vi.fn(async (_tabId: string): Promise<void> => undefined);
  const setColorScheme = vi.fn(
    async (_tabId: string, _colorScheme: string): Promise<void> => undefined,
  );
  const zoomIn = vi.fn(async (_tabId: string): Promise<void> => undefined);
  const zoomOut = vi.fn(async (_tabId: string): Promise<void> => undefined);
  const resetZoom = vi.fn(async (_tabId: string): Promise<void> => undefined);
  const clearCookies = vi.fn(async (_environmentId: string): Promise<void> => undefined);
  const clearCache = vi.fn(async (_environmentId: string): Promise<void> => undefined);
  const setAnnotationSendEnabled = vi.fn(
    async (_tabId: string, _enabled: boolean): Promise<void> => undefined,
  );
  const cancelPickElement = vi.fn(async (_tabId: string): Promise<void> => undefined);
  const pickElement = vi.fn(async (_tabId: string) => null);
  const captureScreenshot = vi.fn(async (): Promise<unknown> => ({
    id: "screenshot-1",
    tabId: "tab-1",
    path: "screenshots/tab-1.png",
    mimeType: "image/png",
    sizeBytes: 128,
    createdAt: "2026-01-01T00:00:00.000Z",
  }));
  const openPictureInPicture = vi.fn(async (_tabId: string): Promise<void> => undefined);
  const closePictureInPicture = vi.fn(async (_tabId: string): Promise<void> => undefined);
  const openExternal = vi.fn(async (_url: string): Promise<boolean> => true);
  const hostBridge = new Proxy(
    {
      preview: {
        navigate,
        goBack,
        goForward,
        refresh,
        hardReload,
        openDevTools,
        setColorScheme,
        zoomIn,
        zoomOut,
        resetZoom,
        clearCookies,
        clearCache,
        setAnnotationSendEnabled,
        cancelPickElement,
        pickElement,
        annotationVoice: { onEvent: () => () => {}, update: async () => {} },
        captureScreenshot,
        pictureInPicture: {
          open: openPictureInPicture,
          close: closePictureInPicture,
        },
        recording: {
          onInput: () => () => {},
          startScreencast: async () => undefined,
          stopScreencast: async () => undefined,
          save: async () => ({}),
        },
        onStateChange: () => () => {},
      },
      openExternal,
    },
    {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
        return () => undefined;
      },
    },
  );
  window.hostBridge = hostBridge as never;
  return {
    navigate,
    goBack,
    goForward,
    refresh,
    hardReload,
    openDevTools,
    setColorScheme,
    zoomIn,
    zoomOut,
    resetZoom,
    clearCookies,
    clearCache,
    setAnnotationSendEnabled,
    cancelPickElement,
    pickElement,
    captureScreenshot,
    openPictureInPicture,
    closePictureInPicture,
    openExternal,
    commitBrowserViewportChange: vi.fn(async () => undefined),
  };
});

vi.mock(import("./usePreviewSession"), () => ({
  usePreviewSession: () => {},
}));
vi.mock(import("~/browser/browserViewportActions"), () => ({
  commitBrowserViewportChange: mocks.commitBrowserViewportChange,
}));

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import {
  applyPreviewDesktopState,
  resetPreviewStateForTests,
  updatePreviewServerSnapshot,
} from "~/previewStateStore";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { previewBridge } from "./previewBridge";
import { PreviewView } from "./PreviewView";

const TEST_THREAD_REF = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;
const TEST_RUNTIME_TAB_ID = previewRuntimeTabId(TEST_THREAD_REF, null, "tab-1");

function seedPreviewState() {
  updatePreviewServerSnapshot(TEST_THREAD_REF, {
    threadId: TEST_THREAD_REF.threadId,
    tabId: "tab-1",
    runtime: "desktop",
    navStatus: { _tag: "Success", url: "http://example.com/", title: "Example" },
    canGoBack: true,
    canGoForward: true,
    updatedAt: "2026-07-13T00:00:00.000Z",
  });
  applyPreviewDesktopState(TEST_THREAD_REF, "tab-1", {
    hasWebContents: true,
    canGoBack: true,
    canGoForward: true,
    loading: false,
    zoomFactor: 1,
    pictureInPicture: false,
    colorScheme: "system",
    audioMuted: false,
    audible: false,
    controller: "none",
    favicon: null,
  });
}

function setup() {
  vi.clearAllMocks();
  mocks.commitBrowserViewportChange.mockResolvedValue(undefined);
  resetPreviewStateForTests();
  seedPreviewState();
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {}, pendingMaximizeThreadKey: null });
  useRightPanelStore.getState().show(TEST_THREAD_REF);
}

function view() {
  return (
    <AppAtomRegistryProvider>
      <PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible />
    </AppAtomRegistryProvider>
  );
}

describe("preview toolbar with the desktop preview bridge", () => {
  it("installs the native bridge when the host exposes it", () => {
    expect(previewBridge).not.toBeNull();
  });

  it("drives navigation, the address bar and screenshots through the host bridge", async () => {
    setup();
    await using _screen = await render(view());

    await userEvent.click(page.getByRole("button", { name: "Back" }));
    expect(mocks.goBack).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID);
    await userEvent.click(page.getByRole("button", { name: "Forward" }));
    expect(mocks.goForward).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID);
    await userEvent.click(page.getByRole("button", { name: "Reload" }));
    expect(mocks.refresh).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID);

    const address = page.getByRole("textbox", { name: "Search or enter URL" });
    await address.fill("http://example.com/next");
    await userEvent.keyboard("{Enter}");
    expect(mocks.navigate).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID, "http://example.com/next");

    await userEvent.click(page.getByRole("button", { name: "Open in system browser" }));
    expect(mocks.openExternal).toHaveBeenCalledWith("http://example.com/");

    await userEvent.click(page.getByRole("button", { name: "Capture screenshot" }));
    await vi.waitFor(() =>
      expect(mocks.captureScreenshot).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID),
    );
  });

  it("picks an element and toggles the floating preview", async () => {
    setup();
    await using _screen = await render(view());

    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() =>
      expect(mocks.pickElement).toHaveBeenCalledWith(
        TEST_RUNTIME_TAB_ID,
        expect.objectContaining({ sessionId: expect.any(String), shortcuts: expect.any(Array) }),
      ),
    );
    expect(mocks.setAnnotationSendEnabled).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID, false);

    await userEvent.click(page.getByRole("button", { name: "Float preview over chat" }));
    await expect
      .element(page.getByRole("button", { name: "Close floating preview" }))
      .toBeVisible();
  });

  it("applies device size and full screen from the toolbar", async () => {
    setup();
    await using _screen = await render(view());

    await userEvent.click(page.getByRole("button", { name: "Device size" }));
    expect(mocks.commitBrowserViewportChange).toHaveBeenCalledWith(
      { threadRef: TEST_THREAD_REF, tabId: "tab-1", runtimeTabId: TEST_RUNTIME_TAB_ID },
      expect.objectContaining({ _tag: "freeform" }),
    );

    await userEvent.click(page.getByRole("button", { name: "Full screen" }));
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, TEST_THREAD_REF)
        .maximized,
    ).toBe(true);
  });

  it("drives the More menu through the host bridge", async () => {
    setup();
    await using _screen = await render(view());

    await userEvent.click(page.getByRole("button", { name: "Preview menu" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Hard reload" }));
    expect(mocks.hardReload).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID);

    await userEvent.click(page.getByRole("button", { name: "Preview menu" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Open DevTools" }));
    expect(mocks.openDevTools).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID);

    await userEvent.click(page.getByRole("button", { name: "Preview menu" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Open separate preview window" }));
    expect(mocks.openPictureInPicture).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID);

    await userEvent.click(page.getByRole("button", { name: "Preview menu" }));
    await userEvent.click(page.getByRole("button", { name: "Zoom in" }));
    expect(mocks.zoomIn).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID);
    await userEvent.click(page.getByRole("button", { name: "Zoom out" }));
    expect(mocks.zoomOut).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID);
    await userEvent.click(page.getByRole("button", { name: "Reset zoom" }));
    expect(mocks.resetZoom).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID);
    await userEvent.keyboard("{Escape}");

    await userEvent.click(page.getByRole("button", { name: "Preview menu" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Appearance" }));
    await userEvent.click(page.getByRole("menuitemradio", { name: "Dark" }));
    expect(mocks.setColorScheme).toHaveBeenCalledWith(TEST_RUNTIME_TAB_ID, "dark");
  });

  it("clears the profile cookies and cache from the More menu", async () => {
    setup();
    await using _screen = await render(view());

    await userEvent.click(page.getByRole("button", { name: "Preview menu" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Clear cookies" }));
    expect(mocks.clearCookies).toHaveBeenCalledWith(TEST_THREAD_REF.environmentId, "default");

    await userEvent.click(page.getByRole("button", { name: "Preview menu" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Clear cache" }));
    expect(mocks.clearCache).toHaveBeenCalledWith(TEST_THREAD_REF.environmentId, "default");
  });
});
