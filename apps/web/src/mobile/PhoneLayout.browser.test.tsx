import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import { ThreadId } from "@houston-app/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import { createMemoryHistory } from "@tanstack/react-router";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useLayoutStore } from "~/layout/layoutStore";
import { configureMotion } from "~/motion/registry";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
} from "../../test/fakeEnvironment";
import { loadEmptyLayout } from "../../test/loadedLayout";
import { render } from "../../test/render";

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

// The draft flow needs server configuration the fake environment does not serve, so the launcher's
// hand-off to the new-thread handler is observed instead of its result.
const harness = vi.hoisted(() => ({ newThread: vi.fn(async (..._args: unknown[]) => null) }));
vi.mock(import("~/hooks/useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: () => harness.newThread as never,
}));

const TITLE = "Tabs thread";
// Composed fixture: a title long enough to overflow the bar and a sheet row on a 320px phone.
const LONG_TITLE =
  "Investigate intermittent ECONNRESET errors on the webhook ingest endpoint when payloads exceed one megabyte";
const PROJECT = "Tabs Project";
installFakeEnvironment(
  [
    { ...threadWithHistory("thread-tabs", 2), title: TITLE },
    { ...threadWithHistory("thread-long", 2), title: LONG_TITLE },
  ],
  { projectTitle: PROJECT },
);

async function mountApp(width: number) {
  loadEmptyLayout();
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(width, 844);
  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = `height: 844px; width: ${width}px;`;
  const screen = await render(<AppRoot router={router} />, { container, router: false });
  return { screen, router };
}

const trigger = () => document.querySelector<HTMLButtonElement>("[data-phone-tabs-trigger]");
const sheet = () => document.querySelector<HTMLElement>("[data-phone-tabs-sheet]");
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-phone-tab-row]")];
const composer = () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]');
const surfaceTab = () => document.querySelector<HTMLElement>("[data-layout-surface-tab]");
const barTitle = () => document.querySelector("[data-phone-bar-title]")?.textContent;

async function openThread(width: number, threadId = "thread-tabs") {
  const app = await mountApp(width);
  const row = await vi.waitFor(
    () => {
      const found = document.querySelector<HTMLElement>(
        `[data-sidebar-row="environment-render:${threadId}"]`,
      );
      expect(found).not.toBeNull();
      return found!;
    },
    { timeout: 5_000 },
  );
  await userEvent.click(row);
  await vi.waitFor(() => expect(trigger()).not.toBeNull(), { timeout: 5_000 });
  return app;
}

/** A restored diff surface for the thread joins the thread's pane as a tab. */
async function addDiffTab(threadId = "thread-tabs") {
  const key = scopedThreadKey(scopeThreadRef(ENVIRONMENT_ID, ThreadId.make(threadId)));
  useRightPanelStore.setState({
    byThreadKey: {
      [key]: { isOpen: true, activeSurfaceId: "diff", surfaces: [{ id: "diff", kind: "diff" }] },
    },
  });
  await vi.waitFor(() => expect(trigger()!.getAttribute("aria-label")).toMatch(/, 2 tabs$/), {
    timeout: 5_000,
  });
}

async function openSheet() {
  await userEvent.click(trigger()!);
  await vi.waitFor(() => expect(sheet()).not.toBeNull(), { timeout: 5_000 });
}

it("opens a thread from the home as the pane that holds its chat", async () => {
  const { screen, router } = await openThread(390);
  await using _screen = screen;

  expect(router.state.location.pathname).toBe("/environment-render/thread-tabs");
  expect(barTitle()).toBe(TITLE);
  await vi.waitFor(() => expect(composer()).not.toBeNull(), { timeout: 5_000 });
  // The thread sits in the layout's focused pane, and nothing on the phone reads a grid.
  const tabs = useLayoutStore
    .getState()
    .layout.workspaces.flatMap((workspace) =>
      workspace.columns.flatMap((column) => column.panes.flatMap((pane) => pane.tabs)),
    );
  expect(tabs.map((tab) => tab.content.kind)).toEqual(["chat"]);
  expect(router.state.location.pathname).not.toMatch(/^\/grid\//);
  expect(document.querySelector("[data-grid-page]")).toBeNull();
});

it("keeps the sheet reachable with one tab", async () => {
  const { screen } = await openThread(390);
  await using _screen = screen;

  const button = trigger()!;
  expect(button.getAttribute("aria-label")).toBe(`${TITLE}, 1 tab`);
  expect(button.querySelector("[data-phone-tabs-count]")!.textContent).toBe("1");
  await openSheet();
  expect(rows()).toHaveLength(1);
  expect(rows()[0]!.querySelector("button")!.getAttribute("aria-current")).toBe("true");
  await expect.element(page.getByRole("button", { name: "New tab" })).toBeVisible();
});

it("lists the pane's tabs and moves to a surface tab and back without remounting the chat", async () => {
  const { screen } = await openThread(390);
  await using _screen = screen;
  await vi.waitFor(() => expect(composer()).not.toBeNull(), { timeout: 5_000 });
  const chatComposer = composer()!;
  await addDiffTab();

  await openSheet();
  expect(rows().map((row) => row.textContent)).toEqual([TITLE, "Diff"]);
  expect(rows()[0]!.querySelector("button")!.getAttribute("aria-current")).toBe("true");
  expect(rows()[1]!.querySelector("button")!.getAttribute("aria-current")).toBeNull();

  await userEvent.click(rows()[1]!.querySelector("button")!);
  await vi.waitFor(() => expect(sheet()).toBeNull(), { timeout: 5_000 });
  await vi.waitFor(() => expect(surfaceTab()).not.toBeNull(), { timeout: 5_000 });
  expect(barTitle()).toBe("Diff");
  // The chat stays mounted, out of sight, while its pane shows the surface.
  expect(chatComposer.isConnected).toBe(true);
  expect(chatComposer.closest("[inert]")).not.toBeNull();

  await openSheet();
  await userEvent.click(rows()[0]!.querySelector("button")!);
  await vi.waitFor(() => expect(surfaceTab()).toBeNull(), { timeout: 5_000 });
  expect(barTitle()).toBe(TITLE);
  expect(composer()).toBe(chatComposer);
  expect(chatComposer.closest("[inert]")).toBeNull();
});

it("closes a tab from the sheet through the layout's close path", async () => {
  const { screen } = await openThread(390);
  await using _screen = screen;
  await addDiffTab();

  await openSheet();
  await userEvent.click(page.getByRole("button", { name: "Close Diff" }));
  await vi.waitFor(() => expect(rows()).toHaveLength(1), { timeout: 5_000 });
  expect(trigger()!.getAttribute("aria-label")).toBe(`${TITLE}, 1 tab`);
  const kinds = useLayoutStore
    .getState()
    .layout.workspaces.flatMap((workspace) =>
      workspace.columns.flatMap((column) =>
        column.panes.flatMap((pane) => pane.tabs.map((tab) => tab.content.kind)),
      ),
    );
  expect(kinds).toEqual(["chat"]);
});

it("opens the launcher from New tab and starts a thread from a project row", async () => {
  const { screen } = await openThread(390);
  await using _screen = screen;

  await openSheet();
  await userEvent.click(page.getByRole("button", { name: "New tab" }));
  await vi.waitFor(() => expect(sheet()).toBeNull(), { timeout: 5_000 });
  await vi.waitFor(() => expect(barTitle()).toBe("New tab"), { timeout: 5_000 });
  expect(trigger()!.getAttribute("aria-label")).toBe("New tab, 2 tabs");
  expect(document.querySelector("[data-new-tab-launcher]")).not.toBeNull();

  await userEvent.click(page.getByText(PROJECT, { exact: true }));
  await vi.waitFor(() => expect(harness.newThread).toHaveBeenCalledTimes(1), { timeout: 5_000 });
  expect(harness.newThread.mock.calls[0]![0]).toMatchObject({ environmentId: ENVIRONMENT_ID });
});

it("keeps a long title on one line in the bar and the sheet at 320px", async () => {
  const { screen } = await openThread(320, "thread-long");
  await using _screen = screen;
  await addDiffTab("thread-long");

  const bar = document.querySelector<HTMLElement>("[data-phone-thread-bar]")!;
  await expect.poll(() => bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth);
  const title = bar.querySelector<HTMLElement>("[data-phone-bar-title]")!;
  expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
  expect(getComputedStyle(title).textOverflow).toBe("ellipsis");
  expect(trigger()!.getBoundingClientRect().right).toBeLessThanOrEqual(320);

  await openSheet();
  const popup = sheet()!;
  expect(popup.scrollWidth).toBeLessThanOrEqual(popup.clientWidth + 1);
  for (const row of rows()) {
    const label = row.querySelector<HTMLElement>("span.truncate")!;
    expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
    const close = row.querySelector<HTMLElement>('button[aria-label^="Close"]')!;
    expect(close.getBoundingClientRect().right).toBeLessThanOrEqual(320);
    expect(close.getBoundingClientRect().height).toBeGreaterThanOrEqual(43.5);
  }
});

it("goes back to the home and returns to the same pane", async () => {
  const { screen, router } = await openThread(390);
  await using _screen = screen;
  await addDiffTab();

  await userEvent.click(page.getByRole("button", { name: "Back to threads" }));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"), { timeout: 5_000 });
  await vi.waitFor(() => expect(document.querySelector("[data-phone-home]")).not.toBeNull(), {
    timeout: 5_000,
  });
  expect(trigger()).toBeNull();

  await userEvent.click(
    document.querySelector<HTMLElement>('[data-sidebar-row="environment-render:thread-tabs"]')!,
  );
  await vi.waitFor(() => expect(trigger()).not.toBeNull(), { timeout: 5_000 });
  expect(trigger()!.getAttribute("aria-label")).toMatch(/, 2 tabs$/);
});

it("draws the sheet without motion when animations are off", async () => {
  using _motion = { [Symbol.dispose]: () => configureMotion({ off: false }) };
  configureMotion({ off: true });
  const { screen } = await openThread(390);
  await using _screen = screen;

  await openSheet();
  const popup = sheet()!;
  const durations = getComputedStyle(popup).transitionDuration.split(",");
  expect(
    durations.every((duration) => parseFloat(duration) === 0),
    durations.join(),
  ).toBe(true);
  const scrim = document.querySelector<HTMLElement>('[data-slot="sheet-backdrop"]');
  if (scrim !== null) {
    expect(parseFloat(getComputedStyle(scrim).transitionDuration)).toBe(0);
  }
});

it.each(["light", "dark"] as const)(
  "paints the bar and sheet from tokens in the %s theme",
  async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      const { screen } = await openThread(390);
      await using _screen = screen;
      await addDiffTab();
      const probe = document.createElement("div");
      probe.style.cssText =
        "background-color: var(--background); border-color: var(--divider); border-bottom: 1px solid var(--divider);";
      document.body.append(probe);
      const token = getComputedStyle(probe);
      const bar = document.querySelector<HTMLElement>("[data-phone-thread-bar]")!;
      expect(getComputedStyle(bar).backgroundColor).toBe(token.backgroundColor);
      expect(getComputedStyle(bar).borderBottomColor).toBe(token.borderBottomColor);
      await openSheet();
      const row = rows()[0]!.querySelector<HTMLElement>("button")!;
      // A selected row and a resting one differ only through tokens: no literal colour is set inline.
      expect(sheet()!.querySelectorAll("[style*='#'], [style*='rgb']")).toHaveLength(0);
      expect(getComputedStyle(row).color).not.toBe("");
      probe.remove();
    } finally {
      document.documentElement.classList.remove("dark");
    }
  },
);
