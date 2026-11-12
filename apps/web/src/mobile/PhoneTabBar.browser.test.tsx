import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { installFakeEnvironment, threadWithHistory } from "../../test/fakeEnvironment";
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

installFakeEnvironment([threadWithHistory("thread-phone", 2)]);

async function mountApp(width: number, height = 844) {
  // A returning user: the first-run gate would otherwise wait on onboarding evidence.
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  loadEmptyLayout();
  await page.viewport(width, height);
  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = `height: ${height}px; width: ${width}px;`;
  const screen = await render(<AppRoot router={router} />, { container, router: false });
  return { screen, router };
}

const phoneHome = () => document.querySelector<HTMLElement>("[data-phone-home]");
const tabBar = () => document.querySelector<HTMLElement>("[data-phone-tab-bar]");
const tab = (name: string) =>
  tabBar()?.querySelector<HTMLElement>(`button[aria-label="${name}"]`) ?? null;
const threadRow = () =>
  document.querySelector<HTMLElement>('[data-sidebar-row="environment-render:thread-phone"]');

async function waitForHome() {
  await vi.waitFor(() => expect(phoneHome()).not.toBeNull(), { timeout: 5_000 });
  await vi.waitFor(() => expect(threadRow()).not.toBeNull(), { timeout: 5_000 });
  await vi.waitFor(() => expect(tabBar()).not.toBeNull(), { timeout: 5_000 });
}

async function openTab(name: string) {
  const target = tab(name);
  expect(target).not.toBeNull();
  await userEvent.click(target!);
}

it("shows the home's top bar and the four-tab bottom bar at 390px", async () => {
  const { screen } = await mountApp(390);
  await using _screen = screen;
  await waitForHome();

  // The top bar replaces the rail's own chrome: search and new thread sit beside the wordmark.
  const home = phoneHome()!;
  await expect.element(screen.getByRole("button", { name: "Search" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "New thread" })).toBeVisible();
  expect(home.querySelector("header")!.textContent).toContain("Houston");
  expect(home.querySelector('input[aria-label="Search workspaces and threads"]')).toBeNull();
  expect(home.querySelector("[data-rail-shortcuts]")).toBeNull();
  expect(home.querySelector('[data-rail-shortcut="Pull requests"]')).toBeNull();
  expect(home.querySelector('[data-rail-shortcut="Usage"]')).toBeNull();

  // Both bars are 44px tall and the top controls keep a 44px hit area.
  expect(home.querySelector("header")!.getBoundingClientRect().height).toBe(44);
  expect(
    screen.getByRole("button", { name: "Search" }).element().getBoundingClientRect().width,
  ).toBeGreaterThanOrEqual(44);
  expect(
    screen.getByRole("button", { name: "New thread" }).element().getBoundingClientRect().width,
  ).toBeGreaterThanOrEqual(44);

  // The list keeps the desktop rail's rows, and the bottom bar carries the four destinations.
  expect(threadRow()).not.toBeNull();
  const bar = tabBar()!;
  expect(bar.getAttribute("aria-label")).toBe("Main");
  expect(bar.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  for (const name of ["Threads", "Pull requests", "Usage", "Settings"]) {
    expect(tab(name)).not.toBeNull();
  }
  expect(tab("Threads")!.getAttribute("aria-current")).toBe("page");
  expect(tab("Threads")!.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  expect(tab("Pull requests")!.getAttribute("aria-current")).toBeNull();
});

it("navigates between the four tabs and marks the open one", async () => {
  const { screen, router } = await mountApp(390);
  await using _screen = screen;
  await waitForHome();

  await openTab("Pull requests");
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/pull-requests"), {
    timeout: 5_000,
  });
  await vi.waitFor(() => expect(tabBar()).not.toBeNull(), { timeout: 5_000 });
  await vi.waitFor(() => expect(tab("Pull requests")?.getAttribute("aria-current")).toBe("page"), {
    timeout: 5_000,
  });

  await openTab("Usage");
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/usage"), { timeout: 5_000 });
  await vi.waitFor(() => expect(tab("Usage")?.getAttribute("aria-current")).toBe("page"), {
    timeout: 5_000,
  });

  await openTab("Settings");
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/settings/general"), {
    timeout: 10_000,
  });
  await vi.waitFor(() => expect(tab("Settings")?.getAttribute("aria-current")).toBe("page"), {
    timeout: 5_000,
  });

  await openTab("Threads");
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"), { timeout: 5_000 });
  await waitForHome();
  expect(tab("Threads")!.getAttribute("aria-current")).toBe("page");

  // The active tab's icon takes the brand ink; a resting one stays muted.
  const probe = document.createElement("span");
  probe.style.color = "var(--accent-ink)";
  document.body.append(probe);
  const accentInk = getComputedStyle(probe).color;
  probe.remove();
  const activeIcon = tab("Threads")!.querySelector("svg")!;
  const restingIcon = tab("Usage")!.querySelector("svg")!;
  expect(getComputedStyle(activeIcon).color).toBe(accentInk);
  expect(getComputedStyle(restingIcon).color).not.toBe(accentInk);
});

it("keeps the tab bar on nested settings pages", async () => {
  const { screen, router } = await mountApp(390);
  await using _screen = screen;
  await waitForHome();

  await openTab("Settings");
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/settings/general"), {
    timeout: 10_000,
  });
  await vi.waitFor(() => expect(tabBar()).not.toBeNull(), { timeout: 5_000 });

  await router.navigate({ to: "/settings/appearance" });
  await vi.waitFor(() => expect(tabBar()).not.toBeNull(), { timeout: 5_000 });
  expect(tab("Settings")!.getAttribute("aria-current")).toBe("page");
});

it("opens the existing search and new-thread flows from the top bar", async () => {
  const { screen } = await mountApp(390);
  await using _screen = screen;
  await waitForHome();

  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  const search = page.getByPlaceholder("Search commands, projects, and threads...");
  await expect.element(search).toBeVisible();
  await expect.element(search).toHaveFocus();
  await userEvent.keyboard("{Escape}");

  await userEvent.click(screen.getByRole("button", { name: "New thread" }));
  // "New thread in..." is the desktop's project picker for a thread without a project.
  const projectSearch = page.getByPlaceholder("Search...");
  await expect.element(projectSearch).toBeVisible();
  await expect.element(projectSearch).toHaveFocus();
  await userEvent.keyboard("{Escape}");
});

it("hides the tab bar on a thread page", async () => {
  const { screen, router } = await mountApp(390);
  await using _screen = screen;
  await waitForHome();

  await userEvent.click(threadRow()!);
  await vi.waitFor(
    () => expect(router.state.location.pathname).toMatch(/^\/environment-render\//),
    {
      timeout: 5_000,
    },
  );
  await vi.waitFor(() => expect(document.querySelector("[data-phone-thread-bar]")).not.toBeNull(), {
    timeout: 5_000,
  });
  expect(tabBar()).toBeNull();
});

it("fits the bars and tabs inside a 320px viewport without sideways scroll", async () => {
  const { screen } = await mountApp(320, 640);
  await using _screen = screen;
  await waitForHome();

  const rootWidth = document.documentElement.clientWidth;
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(rootWidth);
  expect(document.body.scrollWidth).toBeLessThanOrEqual(rootWidth);
  const home = phoneHome()!;
  expect(home.scrollWidth).toBeLessThanOrEqual(home.clientWidth);

  for (const element of [
    home.querySelector("header")!,
    tabBar()!,
    ...["Threads", "Pull requests", "Usage", "Settings"].map((name) => tab(name)!),
  ]) {
    const rect = element.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(rootWidth + 0.5);
  }
});

it("starts the home at the same top offset as another phone page", async () => {
  const { screen, router } = await mountApp(390);
  await using _screen = screen;
  await waitForHome();

  const homeInset = phoneHome()!;
  const homeTop = homeInset.querySelector("header")!.getBoundingClientRect().top;
  const homePaddingTop = getComputedStyle(homeInset).paddingTop;
  // #root already insets for the notch; the page adds no second safe-area padding.
  expect(homePaddingTop).toBe("0px");

  await router.navigate({ to: "/usage" });
  await vi.waitFor(() => expect(phoneHome()).toBeNull(), { timeout: 5_000 });
  await vi.waitFor(
    () => expect(document.querySelector('[data-slot="sidebar-inset"]')).not.toBeNull(),
    { timeout: 5_000 },
  );
  const usageInset = document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]')!;
  expect(getComputedStyle(usageInset).paddingTop).toBe(homePaddingTop);
  expect(usageInset.querySelector("header")!.getBoundingClientRect().top).toBe(homeTop);
});

it("leaves the desktop layout alone at 1024px", async () => {
  const { screen } = await mountApp(1024);
  await using _screen = screen;

  await vi.waitFor(
    () =>
      expect(
        screen.container.querySelector('[data-slot="sidebar"][data-state="expanded"]'),
      ).not.toBeNull(),
    { timeout: 5_000 },
  );
  expect(phoneHome()).toBeNull();
  expect(tabBar()).toBeNull();
});
