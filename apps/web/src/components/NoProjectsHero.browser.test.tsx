import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@houston-app/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../test/render";
import { NoProjectsHero, providerStatusLine } from "./NoProjectsHero";

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

it("collapses the providers into one status line that opens provider settings", async () => {
  state.providers = [
    provider("claudeAgent"),
    provider("codex"),
    missing("opencode"),
    missing("cursor"),
  ];
  await using _screen = await render(<NoProjectsHero />, { router: "/" });

  const line = page.getByRole("button", { name: "Claude Code and Codex ready · 2 not installed" });
  await expect.element(line).toBeVisible();
  // No per-provider rows: the detail lives on the settings page the line opens.
  expect(page.getByText("1.0.0 · signed in").elements()).toHaveLength(0);
  expect(page.getByRole("button", { name: "How to install" }).elements()).toHaveLength(0);
});

it("says when a provider needs attention instead of reporting everything ready", async () => {
  state.providers = [
    provider("claudeAgent"),
    provider("codex", { auth: { status: "unauthenticated" } }),
  ];
  await using _screen = await render(<NoProjectsHero />, { router: "/" });

  await expect.element(page.getByText("Claude Code ready · 1 needs attention")).toBeVisible();
});

it("describes the status line for every mix of provider states", () => {
  expect(providerStatusLine([])).toBe("No providers found");
  expect(providerStatusLine([provider("claudeAgent"), provider("codex"), provider("grok")])).toBe(
    "3 providers ready",
  );
  expect(providerStatusLine([missing("opencode")])).toBe("1 not installed");
});

it("keeps Add folder the dominant action above the status line", async () => {
  state.providers = [provider("claudeAgent"), missing("opencode")];
  await using _screen = await render(<NoProjectsHero />, { router: "/" });

  const add = page.getByRole("button", { name: "Add folder" }).element();
  const line = page.getByRole("button", { name: /Claude Code ready/ }).element();
  expect(add.getBoundingClientRect().bottom).toBeLessThan(line.getBoundingClientRect().top);
  expect(getComputedStyle(add).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
});

it("puts the network note and setup behind an info button instead of on the page", async () => {
  state.providers = [provider("claudeAgent")];
  await using _screen = await render(<NoProjectsHero />, { router: "/" });

  expect(page.getByText(/Houston sends nothing/).elements()).toHaveLength(0);
  expect(page.getByRole("button", { name: "Set up Houston" }).elements()).toHaveLength(0);

  await userEvent.click(page.getByRole("button", { name: "Where your prompts go" }));
  const note = page.getByText(/Houston sends nothing/);
  await expect.element(note).toBeVisible();
  const style = getComputedStyle(note.element());
  expect(style.fontSize).toBe("12px");
  expect(style.fontFamily).not.toContain("JetBrains");
  await expect.element(page.getByRole("button", { name: "Set up Houston" })).toBeVisible();
});

it("leaves one focal action: logo, title, one line, two buttons, status and one secondary link", async () => {
  state.providers = [provider("claudeAgent")];
  await using _screen = await render(<NoProjectsHero />, { router: "/" });

  const main = document.querySelector<HTMLElement>("main")!;
  // Add folder, Clone a repository, the status line and the info button; no scratch target here.
  expect(main.querySelectorAll("button")).toHaveLength(4);
  await expect.element(page.getByText(/Each folder becomes a workspace/)).toBeVisible();
});

it("leaves the header breadcrumb slot empty", async () => {
  state.providers = [provider("claudeAgent")];
  await using screen = await render(<NoProjectsHero />, { router: "/" });

  const header = screen.container.querySelector("header")!;
  expect(header.textContent).toBe("");
});
