import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@houston-app/client-runtime/environment";
import { ThreadId } from "@houston-app/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import "~/index.css";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
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

let bootCount = 0;

async function bootDraftComposer() {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make(`draft-anatomy-${++bootCount}`);
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
      threadId: ThreadId.make(`thread-anatomy-${bootCount}`),
    });
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  const app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  return app;
}

it(
  "lays out the context strip, the footer's primary action and the model shortcut",
  async () => {
    using _environment = installFakeEnvironment([]);
    await using _app = await bootDraftComposer();

    // The strip mounts once the environment connects and the project resolves.
    const strip = await vi.waitFor(
      () => {
        const found = document.querySelector<HTMLElement>('[data-slot="composer-context-strip"]');
        expect(found).not.toBeNull();
        return found!;
      },
      { timeout: 10_000 },
    );
    const card = document.querySelector<HTMLElement>("[data-chat-composer-main-surface]");
    expect(card).not.toBeNull();
    // The strip precedes the card in the DOM and its lower edge slides under the card's top.
    expect(strip.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const stripBox = strip.getBoundingClientRect();
    const cardBox = card!.getBoundingClientRect();
    expect(stripBox.bottom).toBeGreaterThan(cardBox.top);
    expect(stripBox.top).toBeLessThan(cardBox.top);
    // Inset from the card's edges, like a tab.
    expect(stripBox.left).toBeGreaterThan(cardBox.left);
    expect(stripBox.right).toBeLessThan(cardBox.right);

    const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
    expect(footer).not.toBeNull();
    const lastButton = () => [...footer!.querySelectorAll<HTMLButtonElement>("button")].at(-1)!;
    // The label reads "Environment disconnected" until the connection is up.
    await vi.waitFor(() => expect(lastButton().getAttribute("aria-label")).toBe("Submit message"), {
      timeout: 10_000,
    });
    // Nothing follows the primary action, and only one button submits.
    expect(footer!.querySelectorAll('button[type="submit"]')).toHaveLength(1);
    expect(lastButton().type).toBe("submit");

    await userEvent.click(page.getByTestId("composer-editor"));
    await userEvent.keyboard("{Control>}{Shift>}m{/Shift}{/Control}");
    await expect.element(page.getByPlaceholder("Search models")).toBeVisible();
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);
