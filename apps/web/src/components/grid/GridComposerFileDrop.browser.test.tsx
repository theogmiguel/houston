import { createMemoryHistory } from "@tanstack/react-router";
import { ProjectId } from "@houston-app/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  advertiseFileUploads,
  installFakeEnvironment,
  threadWithHistory,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import {
  addThreadToGrid,
  createGridRecord,
  useGridStore,
  workspaceKeyOf,
} from "../../grid/gridStore";

// The socket is the only fake layer: the client runtime hands every connection the in-process session.
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
type FakeDriver = import("../../../test/fakeEnvironment").FakeDriver;

// The fake server leaves most requests unanswered, which would raise the slow-request toast.
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

function seedGrid(threadIds: ReadonlyArray<string>): string {
  const projectId = ProjectId.make("project-render");
  const grid = createGridRecord([], {
    environmentId: ENVIRONMENT_ID,
    projectId,
    workspaceKey: workspaceKeyOf(ENVIRONMENT_ID, projectId),
  });
  const withThreads = threadIds.reduce(
    (record, threadId) => addThreadToGrid(record, threadId),
    grid,
  );
  useGridStore.setState({ grids: [withThreads], threadOrigins: {} });
  return grid.id;
}

function fileDrag(type: "dragenter" | "dragover" | "drop", files: File[]): DragEvent {
  const dataTransfer = new DataTransfer();
  for (const file of files) dataTransfer.items.add(file);
  return new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
}

const cellsOf = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>("[data-grid-cell]"),
];
const cellFor = (container: HTMLElement, threadId: string) =>
  cellsOf(container).find((cell) => cell.getAttribute("data-thread-id") === threadId)!;

async function dropOnCellComposer(cell: HTMLElement, files: File[]) {
  const editor = cell.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  expect(editor).not.toBeNull();
  editor!.dispatchEvent(fileDrag("dragenter", files));
  const over = fileDrag("dragover", files);
  editor!.dispatchEvent(over);
  // Neither the pane-swap drop target nor anything above it may refuse a file drag.
  expect(over.defaultPrevented).toBe(true);
  const drop = fileDrag("drop", files);
  editor!.dispatchEvent(drop);
  expect(drop.defaultPrevented).toBe(true);
}

const tilesIn = (cell: HTMLElement) => cell.querySelectorAll("[data-attachment-tile]");
const chipsIn = (cell: HTMLElement) => cell.querySelectorAll(".composer-inline-chip");

async function renderGrid(gridId: string) {
  await page.viewport(1000, 800);
  const router = getRouter(createMemoryHistory({ initialEntries: [`/grid/${gridId}`] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 800px; width: 1000px;";
  return render(<AppRoot router={router} />, { container, router: false });
}

// Boots the whole app and a three-cell grid; on a loaded 4-vCPU CI runner that has exceeded the default 15 s budget.
const APP_BOOT_TEST_TIMEOUT_MS = 45_000;

it(
  "a file dropped on a narrow cell's composer becomes one tile in that cell only",
  async () => {
    using _environment = installFakeEnvironment([
      threadWithHistory("drop-cell-a", 1),
      threadWithHistory("drop-cell-b", 1),
      threadWithHistory("drop-cell-c", 1),
    ]);
    using _uploads = advertiseFileUploads();
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    const gridId = seedGrid(["drop-cell-a", "drop-cell-b", "drop-cell-c"]);
    await using screen = await renderGrid(gridId);
    await vi.waitFor(() => expect(cellsOf(screen.container)).toHaveLength(3));
    await vi.waitFor(() =>
      expect(screen.container.querySelectorAll('[data-testid="composer-editor"]')).toHaveLength(3),
    );
    const target = cellFor(screen.container, "drop-cell-b");
    const others = ["drop-cell-a", "drop-cell-c"].map((id) => cellFor(screen.container, id));
    expect(target.getBoundingClientRect().width).toBeLessThan(400);

    await dropOnCellComposer(target, [
      new File(["module.exports = {}"], ".pnpmfile.cjs", { type: "text/javascript" }),
      new File(["# notes"], "notes.md", { type: "text/markdown" }),
    ]);

    await vi.waitFor(() => expect(tilesIn(target)).toHaveLength(2));
    expect(chipsIn(target)).toHaveLength(0);
    for (const other of others) expect(tilesIn(other)).toHaveLength(0);
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);
