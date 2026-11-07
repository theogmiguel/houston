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
  "sits the new-thread composer at the foot of the pane with the hero centred above it at %ipx",
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
    const context = document.querySelector<HTMLElement>("[data-draft-project-context]")!;

    // The composer stack rests on the canvas's bottom edge, as it does in a thread.
    const stack = document.querySelector<HTMLElement>('[data-chat-composer-stack="true"]')!;
    expect(Math.abs(stack.getBoundingClientRect().bottom - pane.bottom)).toBeLessThan(2);
    expect(pane.bottom - card.bottom).toBeLessThan(56);
    expect(Math.abs(card.left + card.width / 2 - (pane.left + pane.width / 2))).toBeLessThan(2);

    // The hero is centred in the space between the pane's top and the project context.
    const headingBox = heading.getBoundingClientRect();
    const contextBox = context.getBoundingClientRect();
    const centre = (pane.top + contextBox.top) / 2;
    expect(Math.abs(headingBox.top + headingBox.height / 2 - centre)).toBeLessThan(24);

    // The upward picker's 300px clears the hero above the card.
    expect(headingBox.bottom).toBeLessThan(card.top - 304);
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);

it.each([1440, 800])(
  "puts the project context directly above the composer at %ipx",
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
    const contextBox = context!.getBoundingClientRect();
    expect(contextBox.top).toBeGreaterThan(heading.getBoundingClientRect().bottom);
    expect(contextBox.bottom).toBeLessThanOrEqual(card.top);
    expect(card.top - contextBox.bottom).toBeLessThan(14);
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
