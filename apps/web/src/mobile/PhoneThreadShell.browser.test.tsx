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

// Composed fixture: names long enough to overflow a phone's bar in both segments.
const LONG_PROJECT = "atlas-platform-infrastructure-and-developer-experience";
const LONG_TITLE =
  "Investigate intermittent ECONNRESET errors on the webhook ingest endpoint when payloads exceed one megabyte behind the load balancer";
installFakeEnvironment([{ ...threadWithHistory("thread-phone", 2), title: LONG_TITLE }], {
  projectTitle: LONG_PROJECT,
});

async function mountApp(width: number) {
  // A returning user: the first-run gate would otherwise wait on onboarding evidence.
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  loadEmptyLayout();
  await page.viewport(width, 844);
  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = `height: 844px; width: ${width}px;`;
  const screen = await render(<AppRoot router={router} />, { container, router: false });
  return { screen, router };
}

const phoneHome = () => document.querySelector<HTMLElement>("[data-phone-home]");
const phoneBar = () => document.querySelector<HTMLElement>("[data-phone-thread-bar]");
const threadRow = () =>
  document.querySelector<HTMLElement>('[data-sidebar-row="environment-render:thread-phone"]');

async function openThread(width: number) {
  const { screen, router } = await mountApp(width);
  await vi.waitFor(() => expect(threadRow()).not.toBeNull(), { timeout: 5_000 });
  await userEvent.click(threadRow()!);
  await vi.waitFor(
    () => expect(router.state.location.pathname).toMatch(/^\/environment-render\//),
    {
      timeout: 5_000,
    },
  );
  if (width < 640) {
    await vi.waitFor(() => expect(phoneBar()).not.toBeNull(), { timeout: 5_000 });
  } else {
    await vi.waitFor(() => expect(document.querySelector("[data-layout-strip]")).not.toBeNull(), {
      timeout: 5_000,
    });
  }
  return { screen, router };
}

it("gives a phone thread its own bar with back, title, details and menu", async () => {
  const { screen, router } = await openThread(390);
  await using _screen = screen;

  await expect.element(screen.getByRole("button", { name: "Back to threads" })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: `Thread actions for ${LONG_TITLE}` }))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Thread details" })).toBeVisible();
  // The title is the button that opens the pane's tabs, and it counts them.
  const tabs = screen.getByRole("button", { name: `${LONG_TITLE}, 1 tab` });
  await expect.element(tabs).toBeVisible();
  expect(tabs.element().textContent).toContain("1");
  // The project is on the home page; the bar gives its width to the title.
  expect(phoneBar()!.textContent).not.toContain(LONG_PROJECT);
  expect(phoneBar()!.textContent).toContain(LONG_TITLE);

  // The desktop header, pane actions and rail toggle give way to the bar.
  for (const name of [
    "Toggle main sidebar",
    "Hide sidebar",
    "More layout controls",
    "Tidy panes",
    "Choose tidy layout",
    "Maximize cell",
    "More cell actions",
    "Close thread",
    "Toggle thread details panel",
  ]) {
    await expect.element(screen.getByRole("button", { name })).not.toBeInTheDocument();
  }
  expect(document.querySelector("[data-pane-label]")).toBeNull();
  expect(document.querySelector("[data-panel-layout-controls]")).toBeNull();

  // The shared thread menu opens from the bar.
  await userEvent.click(screen.getByRole("button", { name: `Thread actions for ${LONG_TITLE}` }));
  await expect.element(page.getByRole("menuitem", { name: "Archive thread" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("menuitem", { name: "Archive thread" }))
    .not.toBeInTheDocument();

  // Back returns to the rail's home, which is the only rail on the page.
  await userEvent.click(screen.getByRole("button", { name: "Back to threads" }));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"), { timeout: 5_000 });
  await vi.waitFor(() => expect(phoneHome()).not.toBeNull(), { timeout: 5_000 });
  expect(document.querySelectorAll('[role="navigation"][aria-label="Threads"]')).toHaveLength(1);
  expect(document.querySelector('[data-slot="sidebar"][data-mobile="true"]')).toBeNull();
  await expect
    .element(screen.getByRole("button", { name: "Toggle main sidebar" }))
    .not.toBeInTheDocument();
});

it("keeps the bar inside a 320px viewport with long project and thread names", async () => {
  const { screen } = await openThread(320);
  await using _screen = screen;

  const bar = phoneBar()!;
  await expect.poll(() => bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth);
  const rect = bar.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(320);

  const title = bar.querySelector<HTMLElement>("[data-phone-bar-title]")!;
  expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
  expect(getComputedStyle(title).textOverflow).toBe("ellipsis");

  for (const name of ["Back to threads", `Thread actions for ${LONG_TITLE}`]) {
    const button = screen.getByRole("button", { name }).element();
    const buttonRect = button.getBoundingClientRect();
    expect(buttonRect.left).toBeGreaterThanOrEqual(0);
    expect(buttonRect.right).toBeLessThanOrEqual(320);
  }
});

it("lets the tabs button take the width the controls leave", async () => {
  const { screen } = await openThread(390);
  await using _screen = screen;

  const bar = phoneBar()!;
  const title = bar.querySelector<HTMLElement>("[data-phone-bar-title]")!;
  const trigger = bar.querySelector<HTMLElement>("[data-phone-tabs-trigger]")!;
  const barRect = bar.getBoundingClientRect();
  expect(barRect.height).toBe(44);
  expect(getComputedStyle(bar).borderBottomWidth).toBe("1px");
  const back = screen.getByRole("button", { name: "Back to threads" }).element();
  const menu = screen.getByRole("button", { name: `Thread actions for ${LONG_TITLE}` }).element();
  const details = screen.getByRole("button", { name: "Thread details" }).element();
  const free = details.getBoundingClientRect().left - back.getBoundingClientRect().right;
  // The button fills what the back, details and menu controls leave; the title fills the button
  // less its status glyph, count and chevron.
  expect(trigger.getBoundingClientRect().width).toBeGreaterThan(free - 12);
  expect(title.getBoundingClientRect().width).toBeGreaterThan(free - 100);
  expect(menu.getBoundingClientRect().right).toBeLessThanOrEqual(390);
});

it("keeps the layout's tab bar at 1024px", async () => {
  const { screen } = await openThread(1024);
  await using _screen = screen;

  expect(phoneBar()).toBeNull();
  await expect
    .element(screen.getByRole("button", { name: "Back to threads" }))
    .not.toBeInTheDocument();
  expect(document.querySelector("[data-layout-pane-tab]")).not.toBeNull();
  expect(document.querySelector("[data-phone-tabs-trigger]")).toBeNull();
});
