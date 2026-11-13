import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@houston-app/client-runtime/environment";
import { ThreadId } from "@houston-app/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { loadEmptyLayout } from "../../test/loadedLayout";
import { render } from "../../test/render";

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

// Two project threads give the new-thread page its project context tray.
const PROJECT_THREADS = [threadWithHistory("new-thread-context", 1), threadWithHistory("older", 2)];

const resolveColor = (value: string) => {
  const probe = document.createElement("span");
  probe.style.backgroundColor = value;
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
};

const canvasColor = () => resolveColor("var(--background)");

async function openNewThread() {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  loadEmptyLayout();
  const draftId = DraftId.make("draft-hero-layout");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
      threadId: ThreadId.make("thread-hero-layout"),
    });
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  const app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  return app;
}

async function viewport(width: number): Promise<AsyncDisposable> {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, 900);
  return { [Symbol.asyncDispose]: () => page.viewport(previous.width, previous.height) };
}

function composerBoxes() {
  const overlay = document.querySelector<HTMLElement>("[data-chat-composer-overlay]")!;
  const pane = overlay.parentElement!.getBoundingClientRect();
  const card = document
    .querySelector<HTMLElement>("[data-chat-composer-main-surface]")!
    .getBoundingClientRect();
  const stack = document.querySelector<HTMLElement>('[data-chat-composer-stack="true"]')!;
  return { overlay, pane, card, stack };
}

// A draft in a pane tab shows its composer alone, anchored to the bottom of the pane: the tab
// carries the title and the project context, so no hero heading or project card is drawn.
it.each([1440, 800])(
  "anchors the new-thread composer on the pane's centre line, inside the pane, at %ipx",
  async (width) => {
    using _environment = installFakeEnvironment(PROJECT_THREADS);
    await using _viewport = await viewport(width);
    await using _app = await openNewThread();

    const { pane, card, stack } = composerBoxes();
    expect(document.querySelector("[data-draft-project-context]")).toBeNull();
    expect(page.getByRole("heading", { name: /What should we build/ }).elements()).toHaveLength(0);

    expect(Math.abs(card.left + card.width / 2 - (pane.left + pane.width / 2))).toBeLessThan(2);
    expect(card.left).toBeGreaterThanOrEqual(pane.left);
    expect(card.right).toBeLessThanOrEqual(pane.right);
    expect(stack.getBoundingClientRect().bottom).toBeLessThanOrEqual(pane.bottom);
    // The context tab hangs under the card once the environment reports it, inside the pane.
    const contextTray = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-composer-context-tray]");
      expect(found).not.toBeNull();
      return found!;
    });
    // The bottom-anchored stack grows by the tab, so the card is measured again.
    expect(contextTray.getBoundingClientRect().bottom).toBeGreaterThan(composerBoxes().card.bottom);
    expect(contextTray.getBoundingClientRect().bottom).toBeLessThanOrEqual(pane.bottom);
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it(
  "opens the model picker inside the pane, rising from the bottom-anchored composer",
  async () => {
    using _environment = installFakeEnvironment(PROJECT_THREADS);
    await using _viewport = await viewport(1440);
    await using _app = await openNewThread();

    await userEvent.click(
      document.querySelector<HTMLElement>('[data-chat-provider-model-picker="true"]')!,
    );
    const popup = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="popover-positioner"]');
      expect(found).not.toBeNull();
      return found!;
    });
    const { card, pane } = composerBoxes();
    const box = () => popup.getBoundingClientRect();
    // The popup grows upward into the pane: its bottom stays at the composer's footer and its top
    // clears the top of the pane, so no option is cut off.
    await expect.poll(() => box().top).toBeGreaterThanOrEqual(pane.top);
    expect(box().top).toBeLessThan(card.top);
    expect(box().bottom).toBeLessThanOrEqual(pane.bottom);
    expect(box().bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(box().right).toBeLessThanOrEqual(card.right + 1);
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it(
  "raises the new-thread composer above the canvas with a lifted surface and shadow",
  async () => {
    using _environment = installFakeEnvironment([]);
    await using _viewport = await viewport(1440);
    await using _app = await openNewThread();
    const main = document.querySelector<HTMLElement>("[data-chat-composer-main-surface]")!;
    const style = getComputedStyle(main);
    // A draft in a pane tab uses the composer's own fill and lift; the edge separates it from the canvas.
    expect(style.backgroundColor).toBe(resolveColor("var(--composer)"));
    expect(style.borderTopWidth).toBe("1px");
    expect(style.borderTopColor).not.toBe(canvasColor());
    const probe = document.createElement("div");
    probe.style.boxShadow = "var(--shadow-composer)";
    document.body.append(probe);
    const lift = getComputedStyle(probe).boxShadow;
    probe.remove();
    expect(style.boxShadow).toContain(lift);
    expect(style.borderTopWidth).toBe("1px");
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it(
  "leaves the new-thread canvas flat behind the hero",
  async () => {
    using _environment = installFakeEnvironment([]);
    await using _viewport = await viewport(1440);
    await using _app = await openNewThread();
    const overlay = document.querySelector<HTMLElement>("[data-chat-composer-overlay]")!;
    const style = getComputedStyle(overlay);
    expect(style.backgroundImage).toBe("none");
    expect(style.animationName).toBe("none");
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);
