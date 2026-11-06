import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@houston-app/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../test/render";
import { NoProjectsHero } from "./NoProjectsHero";

const state = vi.hoisted(() => ({ providers: [] as ServerProvider[] }));

vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: (() => new Map()) as never,
  usePrimaryEnvironmentId: () => null,
  useEnvironmentHttpBaseUrl: () => null,
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => state.providers) as never,
}));
vi.mock(import("../hooks/useScratchProject"), () => ({
  useScratchProject: (() => ({
    scratchEnvironmentId: () => null,
    startScratchThread: async () => {},
  })) as never,
}));

function provider(driver: string, overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-30T00:00:00.000Z",
    models: [],
    skills: [],
    slashCommands: [],
    ...overrides,
  };
}

const missing = (driver: string) =>
  provider(driver, {
    installed: false,
    version: null,
    status: "error",
    auth: { status: "unknown" },
  });

it("lists every provider with its version and sign-in state or install hint", async () => {
  state.providers = [
    provider("claudeAgent"),
    provider("codex"),
    missing("opencode"),
    missing("cursor"),
  ];
  await using _screen = await render(<NoProjectsHero />, { router: "/" });

  await expect.element(page.getByText("Claude Code", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Codex", { exact: true })).toBeVisible();
  await expect.element(page.getByText("OpenCode", { exact: true })).toBeVisible();
  expect(page.getByText("1.0.0 · signed in").elements()).toHaveLength(2);
  expect(page.getByText("Not installed").elements()).toHaveLength(2);
  expect(page.getByRole("button", { name: "How to install" }).elements()).toHaveLength(2);
});

it("sets the install action apart from the muted 'Not installed' status", async () => {
  state.providers = [provider("claudeAgent"), missing("opencode")];
  await using _screen = await render(<NoProjectsHero />, { router: "/" });

  const status = getComputedStyle(page.getByText("Not installed").element());
  const action = getComputedStyle(page.getByRole("button", { name: "How to install" }).element());
  expect(action.color).not.toBe(status.color);
  await userEvent.hover(page.getByRole("button", { name: "How to install" }));
  expect(
    getComputedStyle(page.getByRole("button", { name: "How to install" }).element())
      .textDecorationLine,
  ).toBe("underline");
});
