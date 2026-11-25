import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes seconds; importing it here
// keeps that out of the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { loadEmptyLayout } from "../../test/loadedLayout";
import { render } from "../../test/render";
import { selectFocusedTab } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// Boots the whole app; on a loaded 4-vCPU CI runner that has exceeded the default 15 s budget.
const APP_BOOT_TEST_TIMEOUT_MS = 45_000;
const ROW_TIMEOUT_MS = 5_000;
// Both tests open the same thread: the app keeps the previous test's shell snapshot.
const GHOST_THREAD = "ghost-keep";

const focusedTab = () => selectFocusedTab(useLayoutStore.getState().layout)!;
const isGhost = () => focusedTab().ghostOf !== undefined;

/** Opens the app on an empty layout and clicks the sidebar row of `threadName`: its first open. */
async function openThreadFromSidebar(threadName: string) {
  loadEmptyLayout();
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1440, 900);
  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  await router.load();
  const screen = await render(<AppRoot router={router} />, { router: false });
  const row = () =>
    document.querySelector<HTMLElement>(`[data-sidebar-row="environment-render:${threadName}"]`);
  await vi.waitFor(() => expect(row()).not.toBeNull(), { timeout: ROW_TIMEOUT_MS });
  await userEvent.click(row()!);
  await vi.waitFor(() => expect(focusedTab().content.kind).toBe("chat"), {
    timeout: ROW_TIMEOUT_MS,
  });
  return { screen, row };
}

it(
  "keeps the ghost tab of a chat when a message is sent in it",
  async () => {
    using _environment = installFakeEnvironment([threadWithHistory(GHOST_THREAD, 1)]);
    const { screen } = await openThreadFromSidebar(GHOST_THREAD);
    await using _screen = screen;
    expect(isGhost()).toBe(true);
    const tabId = focusedTab().id;

    await userEvent.click(page.getByTestId("composer-editor").element());
    await userEvent.keyboard("Summarize the notes");
    const submit = await vi.waitFor(() => {
      const found = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Submit message"]',
      );
      expect(found).not.toBeNull();
      return found!;
    });
    await userEvent.click(submit);

    await vi.waitFor(() => expect(isGhost()).toBe(false), { timeout: ROW_TIMEOUT_MS });
    expect(focusedTab().id).toBe(tabId);
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it(
  "keeps the focused ghost tab when its thread's sidebar row is clicked again",
  async () => {
    using _environment = installFakeEnvironment([threadWithHistory(GHOST_THREAD, 1)]);
    const { screen, row } = await openThreadFromSidebar(GHOST_THREAD);
    await using _screen = screen;
    expect(isGhost()).toBe(true);
    const tabId = focusedTab().id;

    await userEvent.click(row()!);

    await vi.waitFor(() => expect(isGhost()).toBe(false), { timeout: ROW_TIMEOUT_MS });
    expect(focusedTab().id).toBe(tabId);
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);
