import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@houston-app/client-runtime/environment";
import { ThreadId, type HostBridge } from "@houston-app/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  advertiseFileUploads,
  installFakeEnvironment,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// Boots the whole app; on a loaded 4-vCPU CI runner that has exceeded the default 15 s budget.
const APP_BOOT_TEST_TIMEOUT_MS = 45_000;

let bootCount = 0;

async function bootDraftComposer() {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make(`draft-host-clipboard-${++bootCount}`);
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
      threadId: ThreadId.make(`thread-host-clipboard-${bootCount}`),
    });
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  const app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  return app;
}

// A one-pixel PNG, the shape of what the host reads from the system clipboard.
const PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// A pasted clipboard image can arrive as an event with no types and no files.
function emptyPaste(): ClipboardEvent {
  return new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: new DataTransfer(),
  });
}

// The app reads other bridge members on boot and on render, so the partial bridge exists only
// while the paste is dispatched; the composer takes the reader synchronously in its handler.
function pasteWithHostBridge(
  editor: Element,
  event: ClipboardEvent,
  bridge: Partial<HostBridge>,
): void {
  const previous = window.hostBridge;
  window.hostBridge = bridge as HostBridge;
  try {
    editor.dispatchEvent(event);
  } finally {
    if (previous === undefined) delete window.hostBridge;
    else window.hostBridge = previous;
  }
}

const tiles = () => document.querySelectorAll("[data-attachment-tile]");

it(
  "an empty paste reads the clipboard image from the host and adds one image tile",
  async () => {
    using _environment = installFakeEnvironment([]);
    using _uploads = advertiseFileUploads();
    await using _app = await bootDraftComposer();
    const readClipboardImage = vi.fn(() =>
      Promise.resolve({ mediaType: "image/png", base64: PIXEL_PNG_BASE64 }),
    );
    const editor = page.getByTestId("composer-editor").element();

    const paste = emptyPaste();
    pasteWithHostBridge(editor, paste, { readClipboardImage });

    expect(paste.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(tiles()).toHaveLength(1));
    expect(tiles()[0]?.getAttribute("data-attachment-tile")).toBe("image");
    expect(readClipboardImage).toHaveBeenCalledTimes(1);
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it(
  "an empty paste without a host clipboard reader is left alone",
  async () => {
    using _environment = installFakeEnvironment([]);
    using _uploads = advertiseFileUploads();
    await using _app = await bootDraftComposer();
    const editor = page.getByTestId("composer-editor").element();

    const paste = emptyPaste();
    editor.dispatchEvent(paste);

    expect(paste.defaultPrevented).toBe(false);
    expect(tiles()).toHaveLength(0);
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it(
  "a text paste never asks the host for the clipboard image",
  async () => {
    using _environment = installFakeEnvironment([]);
    using _uploads = advertiseFileUploads();
    await using _app = await bootDraftComposer();
    const readClipboardImage = vi.fn(() => Promise.resolve(null));
    const editor = page.getByTestId("composer-editor").element();

    const data = new DataTransfer();
    data.setData("text/plain", "hello");
    pasteWithHostBridge(
      editor,
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
      { readClipboardImage },
    );

    expect(readClipboardImage).not.toHaveBeenCalled();
    expect(tiles()).toHaveLength(0);
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it(
  "an image copied from a browser arrives as HTML and attaches the clipboard image",
  async () => {
    using _environment = installFakeEnvironment([]);
    using _uploads = advertiseFileUploads();
    await using _app = await bootDraftComposer();
    const readClipboardImage = vi.fn(() =>
      Promise.resolve({ mediaType: "image/png", base64: PIXEL_PNG_BASE64 }),
    );
    const editor = page.getByTestId("composer-editor").element();
    const data = new DataTransfer();
    data.setData(
      "text/html",
      '<meta charset="utf-8"><img src="https://example.com/cat.png" alt="cat">',
    );

    const paste = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    pasteWithHostBridge(editor, paste, { readClipboardImage });

    expect(paste.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(tiles()).toHaveLength(1));
    expect(readClipboardImage).toHaveBeenCalledTimes(1);
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it(
  "rich text with visible content never asks the host for the clipboard image",
  async () => {
    using _environment = installFakeEnvironment([]);
    using _uploads = advertiseFileUploads();
    await using _app = await bootDraftComposer();
    const readClipboardImage = vi.fn(() => Promise.resolve(null));
    const editor = page.getByTestId("composer-editor").element();
    const data = new DataTransfer();
    data.setData("text/html", "<p>Hello <b>there</b></p>");

    pasteWithHostBridge(
      editor,
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
      { readClipboardImage },
    );

    expect(readClipboardImage).not.toHaveBeenCalled();
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it(
  "a paste that only names paths reads nothing until the user confirms the attachment",
  async () => {
    using _environment = installFakeEnvironment([]);
    using _uploads = advertiseFileUploads();
    await using _app = await bootDraftComposer();
    const readDroppedPath = vi.fn(() =>
      Promise.resolve({ name: "id_ed25519", directory: false, base64: btoa("key") }),
    );
    const editor = page.getByTestId("composer-editor").element();
    const data = new DataTransfer();
    data.setData("text/plain", "hello");
    data.setData("text/uri-list", "file:///home/someone/.ssh/id_ed25519");
    const paste = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });

    pasteWithHostBridge(editor, paste, { readDroppedPath });

    expect(paste.defaultPrevented).toBe(true);
    await expect.element(page.getByText('Attach "id_ed25519" from the clipboard?')).toBeVisible();
    expect(readDroppedPath).not.toHaveBeenCalled();
    expect(tiles()).toHaveLength(0);

    // The composer takes the reader synchronously when Attach runs, like the paste handler.
    const attach = page.getByRole("button", { name: "Attach" }).element() as HTMLElement;
    const previous = window.hostBridge;
    window.hostBridge = {
      readDroppedPath,
      getLocalEnvironmentEnabled: () => true,
    } as unknown as HostBridge;
    try {
      attach.click();
    } finally {
      if (previous === undefined) delete window.hostBridge;
      else window.hostBridge = previous;
    }
    // Reading the path and building the tile runs after the dialog closes; on a loaded CI runner
    // that takes longer than the default 1s wait.
    await vi.waitFor(() => expect(tiles()).toHaveLength(1), { timeout: 5_000 });
    expect(readDroppedPath).toHaveBeenCalledWith("/home/someone/.ssh/id_ed25519");
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);
