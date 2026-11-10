import { createMemoryHistory } from "@tanstack/react-router";
import { ProjectId } from "@houston-app/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

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
import { useRightPanelStore } from "../../rightPanelStore";

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

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const THREAD_IDS = ["width-a", "width-b", "width-c", "width-d"];
installFakeEnvironment(THREAD_IDS.map((name) => threadWithHistory(name, 2)));
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

// The card is 280px wide by design; anything under this is a collapsed card showing only its border.
const MIN_VISIBLE_CARD_WIDTH = 200;

it.each([2, 4] as const)(
  "renders the details card at full width in a %i-thread grid",
  async (threadCount) => {
    useRightPanelStore.setState({
      threadPanelVisibilityByThreadKey: {},
      threadPanelPresentationByThreadKey: {},
    });
    const projectId = ProjectId.make("project-render");
    const grid = createGridRecord([], {
      environmentId: ENVIRONMENT_ID,
      projectId,
      workspaceKey: workspaceKeyOf(ENVIRONMENT_ID, projectId),
    });
    const seeded = THREAD_IDS.slice(0, threadCount).reduce(
      (record, threadId) => addThreadToGrid(record, threadId),
      grid,
    );
    useGridStore.setState({ grids: [seeded], threadOrigins: {} });

    await page.viewport(1400, 900);
    const router = getRouter(createMemoryHistory({ initialEntries: [`/grid/${grid.id}`] }));
    await router.load();
    const container = document.createElement("div");
    container.style.cssText = "height: 900px; width: 1400px;";
    await using screen = await render(<AppRoot router={router} />, { container, router: false });
    await vi.waitFor(() => {
      expect(screen.container.querySelectorAll("[data-grid-cell]")).toHaveLength(threadCount);
    });

    await userEvent.click(
      screen.container.querySelector<HTMLButtonElement>(
        '[data-grid-cell][data-focused="true"] [aria-label="Toggle thread details"]',
      )!,
    );

    await vi.waitFor(() => {
      const card = document.querySelector<HTMLElement>("[data-thread-details-card]");
      expect(card).not.toBeNull();
      const rect = card!.getBoundingClientRect();
      expect(rect.width).toBeGreaterThan(MIN_VISIBLE_CARD_WIDTH);
      expect(rect.height).toBeGreaterThan(100);
      expect(card!.textContent?.trim().length).toBeGreaterThan(0);
    });
  },
);
