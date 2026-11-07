import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@houston-app/client-runtime/environment";
import { ThreadId } from "@houston-app/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

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
  type FakeDriver,
} from "../../test/fakeEnvironment";
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
  await expect.element(page.getByRole("heading", { name: /What should we build/ })).toBeVisible();
  return app;
}

async function viewport(width: number): Promise<AsyncDisposable> {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, 900);
  return { [Symbol.asyncDispose]: () => page.viewport(previous.width, previous.height) };
}

it.each([1440, 800])(
  "anchors the new-thread composer in the lower part of the pane, with the hero above it at %ipx",
  async (width) => {
    using _environment = installFakeEnvironment([]);
    await using _viewport = await viewport(width);
    await using _app = await openNewThread();

    const overlay = document.querySelector<HTMLElement>("[data-chat-composer-overlay]")!;
    const pane = overlay.parentElement!.getBoundingClientRect();
    const card = document
      .querySelector<HTMLElement>("[data-chat-composer-main-surface]")!
      .getBoundingClientRect();
    const heading = page.getByRole("heading", { name: /What should we build/ }).element();

    await expect.poll(() => (card.top - pane.top) / pane.height).toBeGreaterThan(0.44);
    expect(heading.getBoundingClientRect().bottom).toBeLessThan(card.top);
    // Room for the docked model picker under the card, clear of the hero above it.
    expect(pane.bottom - card.bottom).toBeGreaterThan(280);
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it.each([1440, 800])(
  "keeps the project context block between the new-thread hero and composer at %ipx",
  async (width) => {
    using _environment = installFakeEnvironment([]);
    await using _viewport = await viewport(width);
    await using _app = await openNewThread();

    const context = document.querySelector<HTMLElement>("[data-draft-project-context]");
    expect(context).not.toBeNull();
    expect(context!.textContent).toContain("Local checkout");
    const heading = page.getByRole("heading", { name: /What should we build/ }).element();
    const card = document
      .querySelector<HTMLElement>("[data-chat-composer-main-surface]")!
      .getBoundingClientRect();
    expect(context!.getBoundingClientRect().top).toBeGreaterThan(
      heading.getBoundingClientRect().bottom,
    );
    expect(context!.getBoundingClientRect().bottom).toBeLessThanOrEqual(card.top);
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it(
  "raises the new-thread composer above the canvas with a lifted surface and shadow",
  async () => {
    using _environment = installFakeEnvironment([]);
    await using _app = await openNewThread();
    const main = document.querySelector<HTMLElement>("[data-chat-composer-main-surface]")!;
    const style = getComputedStyle(main);
    // The light canvas and the raised tier share white; the edge and the lift separate them.
    expect(style.backgroundColor).toBe(resolveColor("var(--surface-raised)"));
    expect(style.borderTopWidth).toBe("1px");
    expect(style.borderTopColor).not.toBe(canvasColor());
    const probe = document.createElement("div");
    probe.style.boxShadow = "var(--shadow-1)";
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
    await using _app = await openNewThread();
    const overlay = document.querySelector<HTMLElement>("[data-chat-composer-overlay]")!;
    const style = getComputedStyle(overlay);
    expect(style.backgroundImage).toBe("none");
    expect(style.animationName).toBe("none");
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);
