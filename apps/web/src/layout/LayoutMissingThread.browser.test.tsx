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
import { buildLayout } from "./layoutFixtures";
import type { LayoutState } from "./layoutModel";
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

const chatTabsOf = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>("[data-layout-chat-tab]"),
];

/** Boots the app on a workspace of one column per thread, so every chat is a narrow pane. */
async function bootColumns(threadIds: ReadonlyArray<string>, width = 1000, height = 800) {
  await page.viewport(width, height);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  useLayoutStore.getState().reset();
  useLayoutStore.getState().setLayoutFromServer(layoutOf([threadIds.map((id) => [[id]])]));
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${threadIds[0]}`] }),
  );
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = `height: ${height}px; width: ${width}px;`;
  const screen = await render(<AppRoot router={router} />, { container, router: false });
  return {
    screen,
    [Symbol.asyncDispose]: async () => {
      await screen[Symbol.asyncDispose]();
      useLayoutStore.getState().reset();
    },
  };
}

it("a tab whose thread no longer exists says so and offers to close the tab", async () => {
  using _environment = installFakeEnvironment([threadWithHistory("kept-thread", 1)], {
    deletedThreadIds: ["ghost-thread"],
  });
  await using app = await bootColumns(["kept-thread", "ghost-thread"]);
  const container = app.screen.container;
  const missing = await vi.waitFor(
    () => {
      const found = container.querySelector<HTMLElement>(
        '[data-layout-missing-thread="ghost-thread"]',
      );
      expect(found).not.toBeNull();
      return found!;
    },
    { timeout: 20_000 },
  );
  // One line and one way forward, drawn by the panel empty state.
  expect(missing.querySelectorAll("p")).toHaveLength(1);
  expect(missing.textContent).toBe("This thread no longer existsClose tab");
  expect(missing.getBoundingClientRect().height).toBeGreaterThan(100);

  const close = [...missing.querySelectorAll("button")].find((b) => b.textContent === "Close tab")!;
  close.click();
  await vi.waitFor(() =>
    expect(container.querySelector('[data-layout-missing-thread="ghost-thread"]')).toBeNull(),
  );
  expect(chatTabsOf(container)).toHaveLength(1);
});
