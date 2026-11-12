import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import { UsageDay, type UsageBucket } from "@houston-app/contracts";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { installFakeEnvironment, threadWithHistory } from "../../../test/fakeEnvironment";
import { loadEmptyLayout } from "../../../test/loadedLayout";
import { render } from "../../../test/render";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);
type FakeDriver = import("../../../test/fakeEnvironment").FakeDriver;

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const bucket = (day: string, costUsd: number): UsageBucket => ({
  day: UsageDay.make(day),
  provider: "codex",
  model: "gpt-5.4",
  totals: {
    uncachedInputTokens: 12_000,
    cachedInputTokens: 48_000,
    cacheCreationTokens: 0,
    outputTokens: 6_000,
    reasoningTokens: 0,
  },
  costUsd,
  cacheSavingsUsd: costUsd / 4,
  costSource: "modelPriced",
  records: 4,
  unpricedRecords: 0,
  sessions: 2,
});

async function mountApp(path: string, width: number, height: number) {
  loadEmptyLayout();
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(width, height);
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = `height: ${height}px; width: ${width}px;`;
  const screen = await render(<AppRoot router={router} />, { container, router: false });
  return { screen, router };
}

const TIMEOUT = 60_000;

it(
  "Usage is a Settings section whose period and metric controls sit above its content",
  async () => {
    using _environment = installFakeEnvironment([threadWithHistory("thread-a", 2)], {
      usage: { buckets: [bucket("2026-11-05", 1.25)] },
    });
    const { screen, router } = await mountApp("/settings/usage", 1280, 800);
    await using _screen = screen;
    await vi.waitFor(() => {
      expect(document.querySelector('[aria-label="Usage metric"]')).not.toBeNull();
    });
    const nav = document.querySelector<HTMLElement>("nav");
    expect(nav?.textContent).toContain("Usage");
    expect(router.state.location.pathname).toBe("/settings/usage");
    const metric = document.querySelector<HTMLElement>('[aria-label="Usage metric"]')!;
    const period = document.querySelector<HTMLElement>('[aria-label="Usage period"]')!;
    const body = document.querySelector<HTMLElement>("[data-usage-body]")!;
    expect(metric.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(period.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      body.getBoundingClientRect().top,
    );
    const card = document.querySelector<HTMLElement>("[data-app-modal]");
    const column = metric.closest<HTMLElement>('[data-workspace-area="settings"]');
    expect(column, "controls live in the settings content column").not.toBeNull();
    expect(card).not.toBeNull();
    // Nothing in the column is wider than the column.
    const columnRect = column!.getBoundingClientRect();
    for (const element of column!.querySelectorAll<HTMLElement>("*")) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0) continue;
      expect(rect.right, element.outerHTML.slice(0, 80)).toBeLessThanOrEqual(columnRect.right + 1);
    }
  },
  TIMEOUT,
);

it(
  "the /usage route opens Settings at the Usage section on a desktop window",
  async () => {
    using _environment = installFakeEnvironment([threadWithHistory("thread-a", 2)], {
      usage: { buckets: [] },
    });
    const { screen, router } = await mountApp("/usage", 1280, 800);
    await using _screen = screen;
    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/usage");
    });
  },
  TIMEOUT,
);
