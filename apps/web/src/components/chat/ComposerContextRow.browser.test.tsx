import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes 6-11s; importing it here keeps
// that out of the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  withPendingChanges,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
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

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// Boots the whole app; on a loaded 4-vCPU CI runner that has exceeded the default 15 s budget.
const APP_BOOT_TEST_TIMEOUT_MS = 45_000;

const CHANGED = withPendingChanges(threadWithHistory("row-changed", 1), [
  { path: "src/a.ts", additions: 3, deletions: 1 },
  { path: "src/b.ts", additions: 2, deletions: 0 },
]);
const CLEAN = threadWithHistory("row-clean", 1);

async function openThread(threadId: string) {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1440, 900);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${threadId}`] }),
  );
  await router.load();
  const app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  return app;
}

const card = () => document.querySelector<HTMLElement>('[data-chat-composer-main-surface="true"]')!;
const contextRow = () => document.querySelector<HTMLElement>('[data-composer-context-row="true"]');

it(
  "puts the checkout, branch and pending changes in one row inside the composer border",
  async () => {
    using _environment = installFakeEnvironment([CHANGED, CLEAN]);
    await using _app = await openThread("row-changed");

    const row = await vi.waitFor(
      () => {
        const found = contextRow();
        expect(found?.querySelector("[data-changed-files-bar]")).not.toBeNull();
        expect(found?.querySelector("[data-composer-context-control]")).not.toBeNull();
        return found!;
      },
      { timeout: 10_000 },
    );
    const rowBox = row.getBoundingClientRect();
    const cardBox = card().getBoundingClientRect();

    // One row, the first inside the card's border, closed by a 1px divider.
    expect(card().contains(row)).toBe(true);
    expect(rowBox.top - cardBox.top).toBeLessThanOrEqual(2);
    expect(getComputedStyle(row).borderBottomWidth).toBe("1px");
    expect(document.querySelectorAll("[data-changed-files-bar]")).toHaveLength(1);
    expect(document.querySelector("[data-composer-context-tray]")).toBeNull();

    // Left: checkout. Right: the summary, a separator, Undo, Keep and the primary Review.
    const summary = row.querySelector<HTMLElement>("[data-changed-files-bar]")!;
    const checkout = row.querySelector<HTMLElement>("[data-composer-context-control]")!;
    expect(summary.textContent).toContain("2 files changed");
    expect(summary.textContent).toContain("+5");
    expect(summary.textContent).toContain("2");
    expect(checkout.getBoundingClientRect().right).toBeLessThanOrEqual(
      summary.getBoundingClientRect().left,
    );
    expect(Math.abs(summary.getBoundingClientRect().right - rowBox.right)).toBeLessThanOrEqual(12);
    // Both halves share one line.
    expect(
      Math.abs(
        summary.getBoundingClientRect().top +
          summary.getBoundingClientRect().height / 2 -
          (checkout.getBoundingClientRect().top + checkout.getBoundingClientRect().height / 2),
      ),
    ).toBeLessThanOrEqual(3);
    expect(rowBox.height).toBeLessThanOrEqual(36);

    // The short labels keep the full action names reachable.
    const undo = page.getByRole("button", { name: "Undo all" });
    const keep = page.getByRole("button", { name: "Keep all" });
    await expect.element(undo).toHaveTextContent("Undo");
    await expect.element(keep).toHaveTextContent("Keep");
    await expect.element(page.getByRole("button", { name: "Review", exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Review 2 files changed" }))
      .toBeVisible();

    // Keep drops the summary; the row keeps its left side.
    await keep.click();
    await vi.waitFor(() => expect(row.querySelector("[data-changed-files-bar]")).toBeNull());
    expect(row.querySelector("[data-composer-context-control]")).not.toBeNull();
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it(
  "shows only the left side of the row when nothing is pending",
  async () => {
    using _environment = installFakeEnvironment([CLEAN]);
    await using _app = await openThread("row-clean");

    const row = await vi.waitFor(
      () => {
        const found = contextRow();
        expect(found?.querySelector("[data-composer-context-control]")).not.toBeNull();
        return found!;
      },
      { timeout: 10_000 },
    );
    expect(row.querySelector("[data-changed-files-bar]")).toBeNull();
    expect(document.querySelector("[data-changed-files-bar]")).toBeNull();
    expect(card().contains(row)).toBe(true);
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it(
  "opens the model picker above the composer in a thread",
  async () => {
    using _environment = installFakeEnvironment([CLEAN]);
    await using _app = await openThread("row-clean");

    const trigger = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-chat-provider-model-picker="true"]');
      expect(found).not.toBeNull();
      return found!;
    });
    trigger.click();
    const popup = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="popover-positioner"]');
      expect(found).not.toBeNull();
      return found!;
    });
    await expect
      .poll(() => popup.getBoundingClientRect().bottom)
      .toBeLessThanOrEqual(trigger.getBoundingClientRect().top);
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it(
  "keeps the row fixed over a long draft and fades the scrolled text under it",
  async () => {
    using _environment = installFakeEnvironment([CHANGED]);
    await using _app = await openThread("row-changed");
    await vi.waitFor(() => expect(contextRow()).not.toBeNull(), { timeout: 10_000 });

    await userEvent.click(page.getByTestId("composer-editor"));
    const lines = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`);
    await userEvent.keyboard(lines.join("{Shift>}{Enter}{/Shift}"));

    const editor = document.querySelector<HTMLElement>(".composer-tiptap")!;
    await vi.waitFor(() => expect(editor.scrollHeight).toBeGreaterThan(editor.clientHeight));
    const rowBottom = () => contextRow()!.getBoundingClientRect().bottom;
    const rowTop = contextRow()!.getBoundingClientRect().top;
    // The editor sits wholly under the row: its scrolling never moves the row.
    expect(editor.getBoundingClientRect().top).toBeGreaterThanOrEqual(rowBottom());

    editor.scrollTop = 48;
    const fade = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-composer-input-fade="true"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(contextRow()!.getBoundingClientRect().top).toBe(rowTop);
    expect(fade.getBoundingClientRect().height).toBe(16);
    expect(fade.getBoundingClientRect().top).toBeGreaterThanOrEqual(rowBottom() - 1);

    editor.scrollTop = 0;
    await vi.waitFor(() =>
      expect(document.querySelector('[data-composer-input-fade="true"]')).toBeNull(),
    );
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);
