import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@houston-app/client-runtime/environment";
import { ThreadId } from "@houston-app/contracts";
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

function fileDrag(type: "dragenter" | "dragover" | "drop", files: File[]): DragEvent {
  const dataTransfer = new DataTransfer();
  for (const file of files) dataTransfer.items.add(file);
  return new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
}

let bootCount = 0;

async function bootDraftComposer() {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make(`draft-file-drop-${++bootCount}`);
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
      threadId: ThreadId.make(`thread-file-drop-${bootCount}`),
    });
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  const app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  return app;
}

const tiles = () => document.querySelectorAll("[data-attachment-tile]");
const inlineChips = () => document.querySelectorAll(".composer-inline-chip");

it(
  "dropping files and an image adds one tile each and no inline chip beside them",
  async () => {
    using _environment = installFakeEnvironment([]);
    using _uploads = advertiseFileUploads();
    await using _app = await bootDraftComposer();
    const editor = page.getByTestId("composer-editor").element();
    await expect.element(page.getByTestId("composer-editor")).toBeVisible();

    const files = [
      new File(["module.exports = {}"], ".pnpmfile.cjs", { type: "text/javascript" }),
      new File(["# notes"], "notes.md", { type: "text/markdown" }),
    ];
    const enter = fileDrag("dragenter", files);
    editor.dispatchEvent(enter);
    editor.dispatchEvent(fileDrag("dragover", files));
    // The drag-over affordance is the workspace drop overlay.
    expect(enter.defaultPrevented).toBe(true);

    const drop = fileDrag("drop", files);
    editor.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);

    await vi.waitFor(() => expect(tiles()).toHaveLength(2));
    expect(inlineChips()).toHaveLength(0);
    expect([...tiles()].map((tile) => tile.getAttribute("data-attachment-tile"))).toEqual([
      "file",
      "file",
    ]);

    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      ),
      (char) => char.charCodeAt(0),
    );
    const image = new File([png], "pixel.png", { type: "image/png" });
    editor.dispatchEvent(fileDrag("dragover", [image]));
    editor.dispatchEvent(fileDrag("drop", [image]));

    await vi.waitFor(() => expect(tiles()).toHaveLength(3));
    // Image tiles render before file tiles, so compare the kinds rather than positions.
    expect(
      [...tiles()].map((tile) => tile.getAttribute("data-attachment-tile")).toSorted(),
    ).toEqual(["file", "file", "image"]);
    expect(inlineChips()).toHaveLength(0);
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);
