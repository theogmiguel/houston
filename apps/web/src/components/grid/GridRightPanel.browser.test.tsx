import { createMemoryHistory } from "@tanstack/react-router";
import { ProjectId, type ThreadPullRequestLink } from "@houston-app/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
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

const PULL_REQUEST: ThreadPullRequestLink = {
  host: "github.com",
  repository: "houston/demo",
  number: 12,
  url: "https://github.com/houston/demo/pull/12",
  repositoryWebUrl: "https://github.com/houston/demo",
  source: "manual",
  linkedAt: "2026-03-17T19:12:28.000Z",
  snapshot: {
    state: "open",
    title: "Surface audit",
    headBranch: "feature/surfaces",
    baseBranch: "main",
    isDraft: false,
    updatedAt: "2026-03-17T19:12:28.000Z",
    syncedAt: "2026-03-17T19:12:28.000Z",
    additions: 3,
    deletions: 1,
    changedFiles: 2,
  },
  stack: null,
};

const THREADS = ["thread-grid-a", "thread-grid-b"].map((name) => ({
  ...threadWithHistory(name, 2),
  pullRequests: [PULL_REQUEST],
}));
installFakeEnvironment(THREADS);
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

function seedGrid(): string {
  useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
  const projectId = ProjectId.make("project-render");
  const grid = createGridRecord([], {
    environmentId: ENVIRONMENT_ID,
    projectId,
    workspaceKey: workspaceKeyOf(ENVIRONMENT_ID, projectId),
  });
  const withThreads = THREADS.reduce((record, thread) => addThreadToGrid(record, thread.id), grid);
  useGridStore.setState({ grids: [withThreads], threadOrigins: {} });
  return grid.id;
}

it(
  "opens the focused thread's right panel beside a two-thread grid",
  { timeout: 60_000 },
  async () => {
    const gridId = seedGrid();
    const router = getRouter(createMemoryHistory({ initialEntries: [`/grid/${gridId}`] }));
    await router.load();
    const container = document.createElement("div");
    container.style.cssText = "height: 900px; width: 1400px;";
    await using screen = await render(<AppRoot router={router} />, { container, router: false });

    await vi.waitFor(() => {
      expect(screen.container.querySelectorAll("[data-grid-cell]")).toHaveLength(2);
    });

    const toggle = screen.container.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle right panel"]',
    );
    expect(toggle).not.toBeNull();
    toggle!.click();

    await vi.waitFor(() => {
      expect(
        screen.container.querySelector("[data-grid-right-panel-host] [data-preview-panel-mode]"),
      ).not.toBeNull();
      expect(screen.container.textContent).toContain("Open a surface");
    });
  },
);

it("opens the device surface from the grid's surface launcher", async () => {
  const gridId = seedGrid();
  const router = getRouter(createMemoryHistory({ initialEntries: [`/grid/${gridId}`] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  await using screen = await render(<AppRoot router={router} />, { container, router: false });

  await vi.waitFor(() => {
    expect(screen.container.querySelectorAll("[data-grid-cell]")).toHaveLength(2);
  });

  screen.container.querySelector<HTMLButtonElement>('[aria-label="Toggle right panel"]')!.click();
  await vi.waitFor(() => {
    expect(screen.container.textContent).toContain("Open a surface");
  });

  const device = await vi.waitFor(() => {
    const found = Array.from(
      screen.container.querySelectorAll<HTMLElement>("button, [aria-disabled='true']"),
    ).find((element) => element.textContent?.trim().startsWith("Device"));
    expect(found).not.toBeUndefined();
    return found!;
  });
  device.click();

  await vi.waitFor(() => {
    expect(screen.container.querySelector('[aria-label="Close Device"]')).not.toBeNull();
  });
});

it("opens both pull request surfaces for a thread with a linked pull request", async () => {
  const gridId = seedGrid();
  const router = getRouter(createMemoryHistory({ initialEntries: [`/grid/${gridId}`] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  await using screen = await render(<AppRoot router={router} />, { container, router: false });

  await vi.waitFor(() => {
    expect(screen.container.querySelectorAll("[data-grid-cell]")).toHaveLength(2);
  });

  const togglePanel = () =>
    screen.container.querySelector<HTMLButtonElement>('[aria-label="Toggle right panel"]')!.click();
  const launchSurface = async (label: string) => {
    const surface = await vi.waitFor(() => {
      const host = screen.container.querySelector("[data-grid-right-panel-host]");
      expect(host).not.toBeNull();
      const found = Array.from(
        host!.querySelectorAll<HTMLElement>("button, [aria-disabled='true']"),
      ).find((element) => element.textContent?.trim().startsWith(label));
      expect(found).not.toBeUndefined();
      return found!;
    });
    surface.click();
  };

  togglePanel();
  await launchSurface("Linked pull requests");
  await vi.waitFor(() => {
    expect(screen.container.querySelector('[aria-label="Close Pull requests"]')).not.toBeNull();
  });

  screen.container.querySelector<HTMLButtonElement>('[aria-label="Close Pull requests"]')!.click();
  await vi.waitFor(() => {
    expect(screen.container.querySelector('[aria-label="Close Pull requests"]')).toBeNull();
  });
  togglePanel();
  await vi.waitFor(() => {
    expect(screen.container.textContent).toContain("Open a surface");
  });
  await launchSurface("Pull request");
  await vi.waitFor(() => {
    expect(screen.container.querySelector('[aria-label="Close #12"]')).not.toBeNull();
  });
});
