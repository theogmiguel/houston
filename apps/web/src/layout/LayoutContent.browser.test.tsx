import { createMemoryHistory } from "@tanstack/react-router";
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
import { selectFocusedTab } from "./layoutModel";
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

const THREADS = ["thread-a", "thread-b"].map((name) => threadWithHistory(name, 2));
installFakeEnvironment(THREADS);
await page.viewport(1400, 900);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

async function bootAt(path: string) {
  useLayoutStore.getState().reset();
  useLayoutStore.getState().setLayoutFromServer(buildLayout([[]]));
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
