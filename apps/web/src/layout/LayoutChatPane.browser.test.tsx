import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { ThreadId } from "@houston-app/contracts";
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
  advertiseFileUploads,
  installFakeEnvironment,
  threadWithHistory,
  threadWithPendingApproval,
  threadWithPendingQuestion,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";
import { buildLayout } from "./layoutFixtures";
import type { LayoutState } from "./layoutModel";
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

/** `buildLayout`'s tabs, pointed at the fake environment's threads. */
function layoutOf(shape: string[][][][]): LayoutState {
  const layout = buildLayout(shape);
  return {
    ...layout,
    workspaces: layout.workspaces.map((workspace) => ({
      ...workspace,
      columns: workspace.columns.map((column) => ({
        ...column,
        panes: column.panes.map((pane) => ({
          ...pane,
          tabs: pane.tabs.map((tab) => ({
            ...tab,
            content: {
              kind: "chat" as const,
              target: {
                kind: "server" as const,
                threadRef: scopeThreadRef(ENVIRONMENT_ID, ThreadId.make(tab.id)),
              },
            },
          })),
        })),
      })),
    })),
  };
}

function fileDrag(type: "dragenter" | "dragover" | "drop", files: File[]): DragEvent {
  const dataTransfer = new DataTransfer();
  for (const file of files) dataTransfer.items.add(file);
  return new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
}

const chatTabsOf = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>("[data-layout-chat-tab]"),
];
const chatTabFor = (container: HTMLElement, threadId: string) =>
  chatTabsOf(container).find((tab) => tab.getAttribute("data-layout-chat-tab") === threadId)!;

const tilesIn = (tab: HTMLElement) => tab.querySelectorAll("[data-attachment-tile]");
const chipsIn = (tab: HTMLElement) => tab.querySelectorAll(".composer-inline-chip");

/** Boots the app on a workspace of one column per thread, so every chat is a narrow pane. */
async function bootColumns(threadIds: ReadonlyArray<string>, width = 1000, height = 800) {
  await page.viewport(width, height);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  useLayoutStore.getState().reset();
  useLayoutStore.getState().setLayoutFromServer(layoutOf([threadIds.map((id) => [[id]])]));
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${threadIds[0]}`] }),
  );
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = `height: ${height}px; width: ${width}px;`;
  const screen = await render(<AppRoot router={router} />, { container, router: false });
  return {
    screen,
    [Symbol.asyncDispose]: async () => {
      await screen[Symbol.asyncDispose]();
      useLayoutStore.getState().reset();
    },
  };
}

// Boots the whole app and a three-column workspace; on a loaded 4-vCPU CI runner that has exceeded
// the default 15 s budget.
const APP_BOOT_TEST_TIMEOUT_MS = 45_000;

it(
  "a file dropped on a narrow pane's composer becomes one tile in that pane only",
  async () => {
    using _environment = installFakeEnvironment([
      threadWithHistory("drop-pane-a", 1),
      threadWithHistory("drop-pane-b", 1),
      threadWithHistory("drop-pane-c", 1),
    ]);
    using _uploads = advertiseFileUploads();
    await using app = await bootColumns(["drop-pane-a", "drop-pane-b", "drop-pane-c"]);
    const container = app.screen.container;
    await vi.waitFor(() => expect(chatTabsOf(container)).toHaveLength(3));
    await vi.waitFor(() =>
      expect(container.querySelectorAll('[data-testid="composer-editor"]')).toHaveLength(3),
    );
    const target = chatTabFor(container, "drop-pane-b");
    const others = ["drop-pane-a", "drop-pane-c"].map((id) => chatTabFor(container, id));
    expect(target.getBoundingClientRect().width).toBeLessThan(400);

    const files = [
      new File(["module.exports = {}"], ".pnpmfile.cjs", { type: "text/javascript" }),
      new File(["# notes"], "notes.md", { type: "text/markdown" }),
    ];
    const editor = target.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
    editor.dispatchEvent(fileDrag("dragenter", files));
    const over = fileDrag("dragover", files);
    editor.dispatchEvent(over);
    // Nothing above the composer, such as a pane drop target, may refuse a file drag.
    expect(over.defaultPrevented).toBe(true);
    const drop = fileDrag("drop", files);
    editor.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);

    await vi.waitFor(() => expect(tilesIn(target)).toHaveLength(2));
    expect(chipsIn(target)).toHaveLength(0);
    for (const other of others) expect(tilesIn(other)).toHaveLength(0);
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

const visibleControls = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("button, a[href]")].filter(
    (control) =>
      control.getClientRects().length > 0 &&
      getComputedStyle(control).visibility !== "hidden" &&
      control.getBoundingClientRect().width > 1,
  );

function overlapping(first: HTMLElement, second: HTMLElement): boolean {
  const a = first.getBoundingClientRect();
  const b = second.getBoundingClientRect();
  return (
    a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1
  );
}

it(
  "keeps the footer row under the composer card whole, with the checkout and the model picker in it, in a narrow pane",
  async () => {
    using _environment = installFakeEnvironment([
      threadWithHistory("pane-composer-a", 1),
      threadWithHistory("pane-composer-b", 1),
    ]);
    await using app = await bootColumns(["pane-composer-a", "pane-composer-b"]);
    const container = app.screen.container;
    await vi.waitFor(() => expect(chatTabsOf(container)).toHaveLength(2));
    await vi.waitFor(() =>
      expect(container.querySelectorAll('[data-testid="composer-editor"]')).toHaveLength(2),
    );

    for (const tab of chatTabsOf(container)) {
      expect(tab.getBoundingClientRect().width).toBeLessThan(400);
      const editor = tab.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
      const footer = await vi.waitFor(() => {
        const found = tab.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
        expect(found).not.toBeNull();
        return found!;
      });
      // Row 1 is the input alone; the card's toolbar sits wholly under it.
      expect(footer.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        editor.getBoundingClientRect().bottom - 1,
      );
      // The checkout and the pickers live in the row under the card, never in the card.
      expect(footer.querySelector("[data-chat-provider-model-picker]")).toBeNull();
      expect(footer.querySelector('[aria-label^="Workspace:"]')).toBeNull();
      const row = tab.querySelector<HTMLElement>('[data-composer-context-tray="true"]')!;
      expect(row).not.toBeNull();
      const card = tab.querySelector<HTMLElement>("[data-chat-composer-main-surface]")!;
      expect(row.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        card.getBoundingClientRect().bottom - 1,
      );
      expect(row.getBoundingClientRect().height).toBeLessThanOrEqual(32);

      // The model chip never shows a clipped name: it is whole, or it dropped to the provider
      // mark with the full name in its tooltip.
      const modelChip = await vi.waitFor(() => {
        const found = row.querySelector<HTMLElement>("[data-chat-provider-model-picker]");
        expect(found).not.toBeNull();
        return found!;
      });
      if (modelChip.dataset.chatProviderModelPickerIconOnly === "true") {
        expect(modelChip.getAttribute("title") ?? "").not.toBe("");
      } else {
        const modelLabel = modelChip.querySelector<HTMLElement>(
          "[data-chat-provider-model-picker-label]",
        )!;
        expect(modelLabel.scrollWidth).toBeLessThanOrEqual(modelLabel.clientWidth + 1);
      }
      // No lock or other unlabelled glyph shows: access is in the model picker's footer.
      expect(row.querySelector('[aria-label^="Permissions:"]')).toBeNull();
      expect(row.querySelector('[aria-label^="Workspace:"]')).not.toBeNull();

      const controls = [...visibleControls(footer), ...visibleControls(row)];
      const footerBox = footer.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      for (const [index, first] of controls.entries()) {
        expect(first.getBoundingClientRect().right).toBeLessThanOrEqual(
          Math.max(footerBox.right, rowBox.right) + 1,
        );
        expect(first.getBoundingClientRect().left).toBeGreaterThanOrEqual(
          Math.min(footerBox.left, rowBox.left) - 1,
        );
        for (const second of controls.slice(index + 1)) {
          expect(
            overlapping(first, second),
            `${first.ariaLabel} overlaps ${second.ariaLabel} in a ${tab.getBoundingClientRect().width}px pane`,
          ).toBe(false);
        }
      }
    }
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

const PENDING_CARDS = [
  { card: "question", fixture: threadWithPendingQuestion, action: /submit/i },
  { card: "approval", fixture: threadWithPendingApproval, action: /approve/i },
] as const;

it.each(PENDING_CARDS)(
  "keeps the $card card's toolbar whole in a narrow pane: no overlap, no label stub, no lock",
  async ({ fixture, action }) => {
    const ids = ["pending-a", "pending-b"];
    using _environment = installFakeEnvironment([
      ...ids.slice(0, -1).map((id) => threadWithHistory(id, 1)),
      fixture("pending-b"),
    ]);
    await using app = await bootColumns(ids);
    const container = app.screen.container;
    await vi.waitFor(() => expect(chatTabsOf(container)).toHaveLength(2));
    const tab = chatTabFor(container, "pending-b");
    expect(tab.getBoundingClientRect().width).toBeLessThan(400);
    const form = await vi.waitFor(() => {
      const found = tab.querySelector<HTMLElement>('[data-chat-composer-form="true"]');
      expect(found).not.toBeNull();
      return found!;
    });
    const footer = await vi.waitFor(() => {
      const found = form.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
      expect(found).not.toBeNull();
      return found!;
    });
    // The approval card is a sibling of the composer form, the question card sits inside it.
    const cardControls = () => [
      ...new Set([
        ...visibleControls(form),
        ...visibleControls(tab.querySelector<HTMLElement>("[data-composer-approval-card]") ?? form),
      ]),
    ];
    await vi.waitFor(() =>
      expect(
        cardControls().some((control) =>
          action.test(control.getAttribute("aria-label") ?? control.textContent ?? ""),
        ),
      ).toBe(true),
    );

    const controls = cardControls();
    const tabBox = tab.getBoundingClientRect();
    for (const [index, first] of controls.entries()) {
      const box = first.getBoundingClientRect();
      expect(box.right, `${first.ariaLabel} right edge`).toBeLessThanOrEqual(tabBox.right + 1);
      expect(box.left, `${first.ariaLabel} left edge`).toBeGreaterThanOrEqual(tabBox.left - 1);
      for (const second of controls.slice(index + 1)) {
        if (first.contains(second) || second.contains(first)) continue;
        expect(
          overlapping(first, second),
          `${first.ariaLabel ?? first.textContent} overlaps ${second.ariaLabel ?? second.textContent}`,
        ).toBe(false);
      }
    }

    // A chip label is whole, with no ellipsis stub of the name, or the chip is its icon.
    const labels = [
      ...footer.querySelectorAll<HTMLElement>(
        "[data-composer-label], [data-chat-provider-model-picker-label]",
      ),
    ].filter((label) => !label.classList.contains("sr-only") && label.getClientRects().length > 0);
    for (const label of labels) {
      const text = label.textContent ?? "";
      expect(label.querySelector("[data-overflow]"), `chip label "${text}" is cut`).toBeNull();
      expect(label.scrollWidth, `chip label "${text}" is cut`).toBeLessThanOrEqual(
        label.clientWidth + 1,
      );
    }

    // No lock: access lives in the model picker's footer.
    expect(footer.querySelector('[aria-label^="Permissions:"]')).toBeNull();
    expect(footer.querySelector("svg.lucide-lock, svg.lucide-lock-keyhole")).toBeNull();
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);
