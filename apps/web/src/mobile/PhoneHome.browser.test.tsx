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

async function mountApp(width: number) {
  // A returning user: the first-run gate would otherwise wait on onboarding evidence.
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

const phoneHome = () => document.querySelector<HTMLElement>("[data-phone-home]");

const threadRow = () =>
  phoneHome()?.querySelector<HTMLElement>('[data-sidebar-row="environment-render:thread-phone"]') ??
  null;

it("opens on the rail as the home page at 390px", async () => {
  const { screen } = await mountApp(390);
  await using _screen = screen;

  await vi.waitFor(() => expect(phoneHome()).not.toBeNull(), { timeout: 5_000 });
  await vi.waitFor(() => expect(threadRow()).not.toBeNull(), { timeout: 5_000 });
  await expect.poll(() => phoneHome()!.getBoundingClientRect().width).toBe(390);

  // The rail is the page, not a drawer: its thread rows are on screen under the phone's own
  // top bar, and the rail's search and shortcut row move to the top and bottom bars.
  expect(threadRow()).not.toBeNull();
  expect(document.querySelector("[data-phone-tab-bar]")).not.toBeNull();
  expect(
    phoneHome()!.querySelector('input[aria-label="Search workspaces, grids and threads"]'),
  ).toBeNull();
  expect(phoneHome()!.querySelector("[data-rail-shortcuts]")).toBeNull();
  expect(phoneHome()!.querySelector('[data-rail-shortcut="Tasks"]')).toBeNull();
  expect(document.querySelector('[data-slot="sidebar"][data-mobile="true"]')).toBeNull();
});

it("shows Needs you by default on a phone and keeps the opt-out", async () => {
  const { screen } = await mountApp(390);
  await using _screen = screen;
  await vi.waitFor(() => expect(phoneHome()).not.toBeNull(), { timeout: 5_000 });

  await userEvent.click(screen.getByRole("button", { name: "View options" }));
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: "Show Needs you" }))
    .toHaveAttribute("aria-checked", "true");
  await userEvent.click(page.getByRole("menuitemcheckbox", { name: "Show Needs you" }));
  await userEvent.keyboard("{Escape}");

  await userEvent.click(screen.getByRole("button", { name: "View options" }));
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: "Show Needs you" }))
    .toHaveAttribute("aria-checked", "false");
});

it("navigates to a thread tapped on the phone home", async () => {
  const { screen, router } = await mountApp(390);
  await using _screen = screen;
  await vi.waitFor(() => expect(threadRow()).not.toBeNull(), { timeout: 5_000 });

  await userEvent.click(threadRow()!);

  await vi.waitFor(() => expect(router.state.location.pathname).toMatch(/^\/grid\//), {
    timeout: 5_000,
  });
});

it("keeps the desktop layout at 1024px", async () => {
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
});
