import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { ThreadId } from "@houston-app/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform takes several seconds.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "~/terminalUiStateStore";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
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

it(
  "sends a !command to the thread's terminal instead of the agent",
  async () => {
    using _environment = installFakeEnvironment([threadWithHistory("composer-bang", 1)]);
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    const threadId = ThreadId.make("composer-bang");
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${threadId}`] }),
    );
    await router.load();
    await using _app = await render(<AppRoot router={router} />, { router: false });

    await expect.element(page.getByTestId("composer-editor")).toBeVisible();
    await userEvent.click(page.getByTestId("composer-editor"));
    await userEvent.keyboard("!echo hi");
    await expect
      .element(page.getByText("Runs in the terminal; not sent to the agent."))
      .toBeVisible();

    await userEvent.keyboard("{Enter}");

    const threadRef = scopeThreadRef(ENVIRONMENT_ID, threadId);
    await expect
      .poll(
        () =>
          selectThreadTerminalUiState(
            useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
            threadRef,
          ).terminalOpen,
        { timeout: 10_000 },
      )
      .toBe(true);
    // The command left the composer and never entered the conversation.
    await expect.element(page.getByTestId("composer-editor")).toHaveTextContent("");
    expect(page.getByText("!echo hi").elements()).toHaveLength(0);
  },
  APP_BOOT_TEST_TIMEOUT_MS,
);
