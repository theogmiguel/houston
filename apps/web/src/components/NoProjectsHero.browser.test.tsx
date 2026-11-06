import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@houston-app/contracts";
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

it("states ready providers in one line and keeps install links behind a disclosure", async () => {
  state.providers = [
    provider("claudeAgent"),
    provider("codex"),
    missing("opencode"),
    missing("cursor"),
  ];
  await using _screen = await render(<NoProjectsHero />, { router: "/" });

  await expect.element(page.getByText("Claude Code and Codex ready")).toBeVisible();
  const disclosure = page.getByRole("button", { name: "2 more providers to set up" });
  await expect.element(disclosure).toBeVisible();
  expect(page.getByText("How to install").elements()).toHaveLength(0);

  await userEvent.click(disclosure);
  await expect.element(page.getByText("OpenCode")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "How to install" }).first()).toBeVisible();
});

it("shows no disclosure when every provider is ready", async () => {
  state.providers = [provider("claudeAgent"), provider("codex")];
  await using _screen = await render(<NoProjectsHero />, { router: "/" });

  await expect.element(page.getByText("Claude Code and Codex ready")).toBeVisible();
  expect(page.getByRole("button", { name: /to set up/ }).elements()).toHaveLength(0);
});
