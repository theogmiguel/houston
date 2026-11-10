import { createMemoryHistory } from "@tanstack/react-router";
import { ProjectId, ThreadId } from "@houston-app/contracts";
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
import { preorderThreads } from "../../grid/tree";

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

async function renderGrid(gridId: string) {
  await page.viewport(1200, 800);
  const router = getRouter(createMemoryHistory({ initialEntries: [`/grid/${gridId}`] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 800px; width: 1200px;";
  return render(<AppRoot router={router} />, { container, router: false });
}

// Boots the whole app; on a loaded 4-vCPU CI runner that has exceeded the default 15 s budget.
const APP_BOOT_TEST_TIMEOUT_MS = 45_000;

it(
  "swaps a subagent's cell back to its parent instead of adding a cell",
  async () => {
    using _environment = installFakeEnvironment([
      threadWithHistory("subagent-parent", 1),
      { ...threadWithHistory("subagent-child", 1), subagentOf: ThreadId.make("subagent-parent") },
    ]);
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    const gridId = seedGrid(["subagent-child"]);
    await using _screen = await renderGrid(gridId);

    // The header crumb and the subagent bar both offer it; either opens the parent.
    await page.getByRole("button", { name: "Open parent" }).first().click();

    const gridThreads = () =>
      preorderThreads(useGridStore.getState().grids.find((grid) => grid.id === gridId)!.tree).map(
        (node) => node.threadId,
      );
    await vi.waitFor(() => expect(gridThreads()).toEqual(["subagent-parent"]));
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

const LONG_HISTORY_TURNS = 40;

/** The strip stays under the header while the timeline is scrolled to its bottom. */
async function expectStripPinnedAtBottom() {
  await vi.waitFor(() =>
    expect(document.querySelector("[data-subagent-parent-header]")).not.toBeNull(),
  );
  const strip = document.querySelector<HTMLElement>("[data-subagent-parent-header]")!;
  const scroller = document.querySelector<HTMLElement>(".messages-timeline-scroll")!;
  expect(scroller).not.toBeNull();
  // It is not a child of what scrolls, so no scroll position can carry it away.
  expect(scroller.contains(strip)).toBe(false);
  expect(strip.getBoundingClientRect().height).toBe(34);

  await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight * 2));
  scroller.scrollTop = scroller.scrollHeight;
  await vi.waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(scroller.clientHeight));
  const box = strip.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  expect(box.bottom).toBeLessThanOrEqual(view.top + 0.5);
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(document.elementFromPoint(box.left + 24, box.top + box.height / 2)).not.toBeNull();
  expect(strip.contains(document.elementFromPoint(box.left + 24, box.top + box.height / 2))).toBe(
    true,
  );
}

it(
  "keeps a subagent's parent strip under the pane header at the bottom of a long timeline",
  async () => {
    using _environment = installFakeEnvironment([
      threadWithHistory("subagent-parent", 1),
      {
        ...threadWithHistory("subagent-child", LONG_HISTORY_TURNS),
        subagentOf: ThreadId.make("subagent-parent"),
      },
    ]);
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    const gridId = seedGrid(["subagent-child"]);
    await using _screen = await renderGrid(gridId);
    await expectStripPinnedAtBottom();
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it(
  "keeps a subagent's parent strip under the header in the single-thread view",
  async () => {
    using _environment = installFakeEnvironment([
      threadWithHistory("subagent-parent", 1),
      {
        ...threadWithHistory("subagent-child", LONG_HISTORY_TURNS),
        subagentOf: ThreadId.make("subagent-parent"),
      },
    ]);
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    await page.viewport(1200, 800);
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/subagent-child`] }),
    );
    await router.load();
    const container = document.createElement("div");
    container.style.cssText = "height: 800px; width: 1200px;";
    await using _screen = await render(<AppRoot router={router} />, { container, router: false });
    await expectStripPinnedAtBottom();
    await page.getByRole("button", { name: "Open parent" }).first().click();
    await vi.waitFor(() => expect(router.state.location.pathname).toContain("subagent-parent"));
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);
