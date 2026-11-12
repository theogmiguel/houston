import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { ThreadId } from "@houston-app/contracts";
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
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";
import { openThreadInLayout } from "../threads/openThreadInLayout";
import { buildLayout } from "./layoutFixtures";
import { selectFocusedTab, type LayoutState } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";

// The socket is the only fake layer: the client runtime hands every connection the in-process session.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});
type FakeDriver = import("../../test/fakeEnvironment").FakeDriver;

// The fake server leaves most requests unanswered, which would raise the slow-request toast.
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// A new draft reads the project's defaults file, which the fake server never answers.
vi.mock(import("../lib/houstonProjectFileDefaults"), async (original) => ({
  ...(await original()),
  readHoustonProjectFile: async () => null,
}));

const THREADS = ["thread-a", "thread-b", "thread-c"].map((name) => threadWithHistory(name, 2));
installFakeEnvironment(THREADS);
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

/** `buildLayout`'s tabs, pointed at the fake environment's threads. */
function layoutOf(shape: string[][][][]): LayoutState {
  const layout = buildLayout(shape);
  return {
    ...layout,
    workspaces: layout.workspaces.map((workspace) => ({
      ...workspace,
      columns: workspace.columns.map((column) => ({
        ...column,
        panes: column.panes.map((pane) => ({
          ...pane,
          tabs: pane.tabs.map((tab) => ({
            ...tab,
            content: {
              kind: "chat" as const,
              target: {
                kind: "server" as const,
                threadRef: scopeThreadRef(ENVIRONMENT_ID, ThreadId.make(tab.id)),
              },
            },
          })),
        })),
      })),
    })),
  };
}

const focusedTabId = () => selectFocusedTab(useLayoutStore.getState().layout)?.id ?? null;
const tabCount = () =>
  useLayoutStore
    .getState()
    .layout.workspaces.reduce(
      (total, workspace) =>
        total +
        workspace.columns.reduce(
          (inColumn, column) =>
            inColumn + column.panes.reduce((inPane, pane) => inPane + pane.tabs.length, 0),
          0,
        ),
      0,
    );

async function bootAt(path: string, shape: string[][][][] = [[]]) {
  useLayoutStore.getState().reset();
  useLayoutStore.getState().setLayoutFromServer(layoutOf(shape));
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  const screen = await render(<AppRoot router={router} />, { container, router: false });
  return {
    screen,
    router,
    [Symbol.asyncDispose]: async () => {
      await screen[Symbol.asyncDispose]();
      useLayoutStore.getState().reset();
    },
  };
}

// Boots the whole app; on a loaded machine that has exceeded the default 15 s budget.
const APP_BOOT_TEST_TIMEOUT_MS = 45_000;

const threadPath = (name: string) => `/${ENVIRONMENT_ID}/${name}`;

it(
  "a chat tab carries the thread's header with its panel toggles",
  async () => {
    await using app = await bootAt(threadPath("thread-a"));
    await vi.waitFor(() => {
      expect(
        app.screen.container.querySelector("[data-layout-chat-tab] [data-chat-header]"),
      ).not.toBeNull();
    });
    const header = app.screen.container.querySelector("[data-layout-chat-tab] [data-chat-header]")!;
    expect(header.querySelector('[aria-label="Toggle right panel"]')).not.toBeNull();
    expect(header.querySelector('[aria-label="Toggle terminal drawer"]')).not.toBeNull();
    expect(selectFocusedTab(useLayoutStore.getState().layout)?.content.kind).toBe("chat");
    await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

const rowStartingWith = (container: Element, label: string) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-layout-launcher-row]")).find((row) =>
    row.textContent?.startsWith(label),
  );

it(
  "the toggle in a chat tab's header opens the thread's surface as a tab beside it",
  async () => {
    await using app = await bootAt(threadPath("thread-a"));
    await vi.waitFor(() => {
      expect(
        app.screen.container.querySelector(
          '[data-layout-chat-tab] [aria-label="Toggle right panel"]',
        ),
      ).not.toBeNull();
    });
    app.screen.container
      .querySelector<HTMLButtonElement>('[data-layout-chat-tab] [aria-label="Toggle right panel"]')!
      .click();
    await vi.waitFor(() => {
      expect(app.screen.container.querySelector("[data-layout-surface-tab]")).not.toBeNull();
    });
    expect(app.screen.container.querySelector("[data-layout-chat-tab]")).not.toBeNull();
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it(
  "the launcher starts a new thread in its own tab",
  async () => {
    await using app = await bootAt("/");
    await vi.waitFor(() => {
      expect(app.screen.container.querySelector("[data-new-tab-launcher]")).not.toBeNull();
      expect(rowStartingWith(app.screen.container, "render")).toBeDefined();
    });
    rowStartingWith(app.screen.container, "render")!.click();
    await vi.waitFor(() => {
      expect(app.router.state.location.pathname).toMatch(/^\/draft\//);
      expect(app.screen.container.querySelector("[data-layout-chat-tab]")).not.toBeNull();
    });
    const focused = selectFocusedTab(useLayoutStore.getState().layout);
    expect(focused?.content).toMatchObject({ kind: "chat", target: { kind: "draft" } });
    expect(tabCount()).toBe(1);
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it(
  "opening a thread focuses the tab that already shows it, and opens one that is not shown",
  async () => {
    await using app = await bootAt(threadPath("thread-a"), [[[["thread-a", "thread-b"]]]]);
    await vi.waitFor(() => expect(focusedTabId()).toBe("thread-a"));

    const open = (name: string) =>
      openThreadInLayout(
        {
          navigate: (options) => app.router.navigate(options),
          pathname: () => app.router.state.location.pathname,
        },
        scopeThreadRef(ENVIRONMENT_ID, ThreadId.make(name)),
      );
    await open("thread-b");
    await vi.waitFor(() => expect(focusedTabId()).toBe("thread-b"));
    expect(tabCount()).toBe(2);
    expect(app.router.state.location.pathname).toBe(threadPath("thread-b"));

    await open("thread-c");
    await vi.waitFor(() => {
      expect(app.router.state.location.pathname).toBe(threadPath("thread-c"));
      expect(selectFocusedTab(useLayoutStore.getState().layout)?.content).toMatchObject({
        kind: "chat",
        target: { threadRef: { threadId: "thread-c" } },
      });
    });
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it(
  "a grid link focuses the workspace with the grid's id and leaves the retired route",
  async () => {
    await using app = await bootAt("/grid/w1", [[[["thread-a"]]], [[["thread-b"]]]]);
    await vi.waitFor(() => {
      expect(useLayoutStore.getState().layout.focusedWorkspaceId).toBe("w1");
      expect(app.router.state.location.pathname).not.toMatch(/^\/grid\//);
    });
    await vi.waitFor(() => expect(focusedTabId()).toBe("thread-b"));
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);
