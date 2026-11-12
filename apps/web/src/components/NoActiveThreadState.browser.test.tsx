import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@houston-app/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
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

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const MISSING_ID = "thread-that-was-deleted";

async function mountMissingThread() {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  loadEmptyLayout();
  await page.viewport(1440, 900);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${MISSING_ID}`] }),
  );
  await router.load();
  const screen = await render(<AppRoot router={router} />, { router: false });
  return { screen, router };
}

it("explains an unknown thread id with a header, the id and three working actions", async () => {
  using _environment = installFakeEnvironment([threadWithHistory("other-thread", 1)], {
    deletedThreadIds: [MISSING_ID],
  });
  using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const { screen, router } = await mountMissingThread();
  await using _screen = screen;

  await expect
    .element(screen.getByRole("heading", { name: "This thread no longer exists" }))
    .toBeVisible();
  // The normal one-line header names the state; the page is never blank.
  await expect.element(screen.getByText("Thread not found")).toBeVisible();
  const idElement = screen.getByText(MISSING_ID);
  await expect.element(idElement).toBeVisible();
  expect(getComputedStyle(idElement.element()).fontFamily).toMatch(/mono/i);

  for (const name of ["Open archive", "New thread", "Copy ID"]) {
    await expect.element(screen.getByRole("button", { name })).toBeVisible();
  }

  await screen.getByRole("button", { name: "Copy ID" }).click();
  await expect.element(screen.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(write).toHaveBeenCalledWith(MISSING_ID);

  await userEvent.click(screen.getByRole("button", { name: "Open archive" }));
  await expect.poll(() => router.state.location.pathname).toBe("/settings/archived");
});

it("leaves the unknown thread route for a new thread", async () => {
  using _environment = installFakeEnvironment([threadWithHistory("other-thread", 1)], {
    deletedThreadIds: [MISSING_ID],
  });
  const { screen, router } = await mountMissingThread();
  await using _screen = screen;

  await userEvent.click(screen.getByRole("button", { name: "New thread" }));
  await expect.poll(() => router.state.location.pathname).not.toContain(MISSING_ID);
});
