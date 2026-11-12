import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  installFakeEnvironment,
  threadWithHistory,
  withPendingChanges,
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

const changedFiles = [{ path: "src/App.tsx", additions: 3, deletions: 1 }];
installFakeEnvironment(
  [
    withPendingChanges(threadWithHistory("thread-phone", 2), changedFiles),
    withPendingChanges(
      {
        ...threadWithHistory("thread-long-branch", 2),
        branch: "feature/a-much-longer-branch-name",
      },
      changedFiles,
    ),
  ],
  {
    // The rail reads each row's diff totals from the project's working tree.
    vcsStatus: {
      local: {
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "feature/phone",
        hasWorkingTreeChanges: true,
        workingTree: {
          files: [{ path: "src/App.tsx", insertions: 3, deletions: 1 }],
          insertions: 3,
          deletions: 1,
        },
        branchChanges: { baseRef: "main", insertions: 3, deletions: 1 },
      },
      remote: null,
    },
  },
);

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

it("puts the wordmark and the bar's last glyph on the 16px gutters", async () => {
  for (const width of [390, 320]) {
    const { screen } = await mountApp(width);
    await using _screen = screen;
    await vi.waitFor(() => expect(phoneHome()).not.toBeNull(), { timeout: 5_000 });
    const bar = phoneHome()!.querySelector<HTMLElement>("header")!;
    const mark = bar.querySelector("img")!.getBoundingClientRect();
    expect(Math.round(mark.left), `wordmark left gutter at ${width}px`).toBe(16);
    const glyphs = bar.querySelectorAll("button svg");
    const last = glyphs[glyphs.length - 1]!.getBoundingClientRect();
    expect(Math.round(width - last.right), `last glyph right gutter at ${width}px`).toBe(16);
    await screen.unmount();
  }
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

  await vi.waitFor(
    () => expect(router.state.location.pathname).toMatch(/^\/environment-render\//),
    {
      timeout: 5_000,
    },
  );
});

it("ends every row's diff stat at the same gap before its provider mark", async () => {
  for (const width of [390, 320]) {
    const { screen } = await mountApp(width);
    await using _screen = screen;
    await vi.waitFor(() => expect(threadRow()).not.toBeNull(), { timeout: 5_000 });
    await vi.waitFor(
      () =>
        expect(phoneHome()!.querySelectorAll("[data-thread-diff]").length).toBeGreaterThanOrEqual(
          2,
        ),
      { timeout: 5_000 },
    );

    const rows = [...phoneHome()!.querySelectorAll<HTMLElement>("[data-thread-diff]")].map(
      (stat) => {
        const line = stat.closest<HTMLElement>("[data-thread-meta]")!;
        const mark = line.querySelector<HTMLElement>("[data-thread-provider-mark]")!;
        const branch = line.querySelector<HTMLElement>("[data-thread-branch] span.truncate");
        return {
          gap: Math.round(mark.getBoundingClientRect().left - stat.getBoundingClientRect().right),
          // The stat never overlaps the branch name that shares its line.
          clear:
            branch === null ||
            stat.getBoundingClientRect().left >= branch.getBoundingClientRect().right,
        };
      },
    );
    expect(rows.length, `rows whose stat is shown at ${width}px`).toBeGreaterThanOrEqual(2);
    expect(
      new Set(rows.map((row) => row.gap)).size,
      `gap before the provider mark: ${rows.map((row) => row.gap).join(", ")}`,
    ).toBe(1);
    expect(
      rows.every((row) => row.clear),
      `stat clear of the branch at ${width}px`,
    ).toBe(true);
    await screen.unmount();
  }
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
