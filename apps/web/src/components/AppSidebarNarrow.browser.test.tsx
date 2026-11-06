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
import { act, fakeTimers, render } from "../../test/render";

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

installFakeEnvironment([threadWithHistory("thread-narrow", 2)]);
__setClientSettingsForTests({
  ...DEFAULT_CLIENT_SETTINGS,
  onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
});

async function mountApp(width: number) {
  await page.viewport(width, 900);
  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = `height: 900px; width: ${width}px;`;
  const screen = await render(<AppRoot router={router} />, { container, router: false });
  return { screen, router };
}

const threadsNav = () =>
  document.querySelector<HTMLElement>('[role="navigation"][aria-label="Threads"]');

// The rail mounts only while the drawer is open, so anything in it that closes the drawer on
// mount (rather than on a navigation) makes the drawer unopenable. Unit harnesses with a bare
// Sidebar cannot see that; this mounts the app's own layout and rail.
it.each([800, 700])("opens the thread rail as a drawer from the toggle at %ipx", async (width) => {
  const { screen } = await mountApp(width);
  await using _screen = screen;
  const toggle = screen.getByRole("button", { name: "Toggle main sidebar" });
  await expect.element(toggle).toBeVisible();
  expect(threadsNav()).toBeNull();

  await userEvent.click(toggle);

  await vi.waitFor(() => expect(threadsNav()).not.toBeNull(), { timeout: 5_000 });
  await expect.poll(() => threadsNav()?.getBoundingClientRect().width ?? 0).toBeGreaterThan(200);
});

it("closes the drawer when the page changes", async () => {
  const { screen, router } = await mountApp(800);
  await using _screen = screen;
  await userEvent.click(screen.getByRole("button", { name: "Toggle main sidebar" }));
  await vi.waitFor(() => expect(threadsNav()).not.toBeNull(), { timeout: 5_000 });

  await router.navigate({ to: "/usage" });

  await vi.waitFor(() => expect(threadsNav()).toBeNull(), { timeout: 5_000 });
});

it("docks the thread rail beside the page at 1280px", async () => {
  const { screen } = await mountApp(1280);
  await using _screen = screen;
  await vi.waitFor(() => expect(threadsNav()).not.toBeNull(), { timeout: 5_000 });
  expect(
    screen.container.querySelector('[data-slot="sidebar"][data-state="expanded"]'),
  ).not.toBeNull();
});

const toggleTooltip = () =>
  [...document.querySelectorAll<HTMLElement>('[data-slot="tooltip-popup"]')].find((popup) =>
    popup.textContent?.startsWith("Toggle main sidebar"),
  ) ?? null;

it("opens no tooltip when closing the drawer returns focus to the toggle", async () => {
  const { screen } = await mountApp(800);
  await using _screen = screen;
  const toggle = screen.getByRole("button", { name: "Toggle main sidebar" });
  await userEvent.click(toggle);
  await vi.waitFor(() => expect(threadsNav()).not.toBeNull(), { timeout: 5_000 });

  await userEvent.keyboard("{Escape}");

  await vi.waitFor(() => expect(threadsNav()).toBeNull(), { timeout: 5_000 });
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Toggle main sidebar"),
  );
  {
    // Base UI opens focus tooltips after a short delay; run its timers past that delay.
    using _timers = fakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(toggleTooltip()).toBeNull();
  }

  // Hover still opens it, and so does focus the user moves there with Tab.
  await userEvent.hover(toggle);
  await vi.waitFor(() => expect(toggleTooltip()).not.toBeNull(), { timeout: 10_000 });
});

it("opens the toggle's tooltip on keyboard focus after the drawer has closed", async () => {
  const { screen } = await mountApp(800);
  await using _screen = screen;
  await userEvent.click(screen.getByRole("button", { name: "Toggle main sidebar" }));
  await vi.waitFor(() => expect(threadsNav()).not.toBeNull(), { timeout: 5_000 });
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(threadsNav()).toBeNull(), { timeout: 5_000 });

  await vi.waitFor(
    () => expect(document.activeElement?.getAttribute("aria-label")).toBe("Toggle main sidebar"),
    { timeout: 10_000 },
  );

  // Focus leaves the toggle, then the user returns to it with the keyboard.
  (document.activeElement as HTMLElement).blur();
  await userEvent.keyboard("{Tab}");
  document.querySelector<HTMLElement>('[aria-label="Toggle main sidebar"]')?.focus();

  await vi.waitFor(() => expect(toggleTooltip()).not.toBeNull(), { timeout: 5_000 });
});

it("draws the closed drawer's toggle like any other header icon button at rest", async () => {
  const { screen } = await mountApp(800);
  await using _screen = screen;
  const toggle = screen.getByRole("button", { name: "Toggle main sidebar" });
  await expect.element(toggle).toBeVisible();
  const element = toggle.element();
  expect(element.getAttribute("aria-pressed")).toBe("false");
  expect(getComputedStyle(element).backgroundColor).toBe("rgba(0, 0, 0, 0)");

  await userEvent.hover(toggle);
  await expect.poll(() => getComputedStyle(element).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
});
