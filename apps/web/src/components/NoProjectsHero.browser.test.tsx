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

const state = vi.hoisted(() => ({
  providers: [] as ServerProvider[],
  scratchEnvironmentId: null as string | null,
}));

vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: (() => new Map()) as never,
  usePrimaryEnvironmentId: () => null,
  useEnvironmentHttpBaseUrl: () => "http://127.0.0.1:10443",
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => state.providers) as never,
}));
vi.mock(import("../hooks/useScratchProject"), () => ({
  useScratchProject: (() => ({
    scratchEnvironmentId: () => state.scratchEnvironmentId as never,
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

it("lists installed providers and folds the missing ones behind one disclosure row", async () => {
  state.providers = [
    provider("claudeAgent"),
    provider("codex"),
    missing("opencode"),
    missing("cursor"),
  ];
  await using _screen = await render(<NoProjectsHero />, { router: "/" });

  await expect.element(page.getByText("Claude Code", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Codex", { exact: true })).toBeVisible();
  expect(page.getByText("1.0.0 · signed in").elements()).toHaveLength(2);

  const disclosure = page.getByText("2 more not installed");
  await expect.element(disclosure).toBeVisible();
  await expect.element(page.getByText("OpenCode", { exact: true })).not.toBeVisible();
  expect(page.getByRole("button", { name: "How to install" }).elements()).toHaveLength(0);

  await userEvent.click(disclosure);
  await expect.element(page.getByText("OpenCode", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Cursor", { exact: true })).toBeVisible();
  expect(page.getByText("Not installed").elements()).toHaveLength(2);
  expect(page.getByRole("button", { name: "How to install" }).elements()).toHaveLength(2);
});

it("omits the disclosure row when every provider is installed", async () => {
  state.providers = [provider("claudeAgent"), provider("codex")];
  await using _screen = await render(<NoProjectsHero />, { router: "/" });

  await expect.element(page.getByText("Codex", { exact: true })).toBeVisible();
  expect(page.getByText(/more not installed/).elements()).toHaveLength(0);
});

it("keeps Add folder the dominant action above the provider card", async () => {
  state.providers = [provider("claudeAgent"), missing("opencode")];
  await using _screen = await render(<NoProjectsHero />, { router: "/" });

  const add = page.getByRole("button", { name: "Add folder" }).element();
  const card = page.getByText("1 more not installed").element().closest("details")!;
  expect(add.getBoundingClientRect().bottom).toBeLessThan(card.getBoundingClientRect().top);
  expect(getComputedStyle(add).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
});

it("sets the install action apart from the muted 'Not installed' status", async () => {
  state.providers = [provider("claudeAgent"), missing("opencode")];
  await using _screen = await render(<NoProjectsHero />, { router: "/" });
  await userEvent.click(page.getByText("1 more not installed"));

  const status = getComputedStyle(page.getByText("Not installed").element());
  const action = getComputedStyle(page.getByRole("button", { name: "How to install" }).element());
  expect(action.color).not.toBe(status.color);
  await userEvent.hover(page.getByRole("button", { name: "How to install" }));
  expect(
    getComputedStyle(page.getByRole("button", { name: "How to install" }).element())
      .textDecorationLine,
  ).toBe("underline");
});

it("sets the privacy note on one 12px sans line and Set up Houston as a ghost button", async () => {
  await page.viewport(1440, 900);
  state.providers = [provider("claudeAgent")];
  await using _screen = await render(<NoProjectsHero />, { router: "/" });

  const note = page.getByText(/Runs locally at 127\.0\.0\.1:10443/).element();
  const style = getComputedStyle(note);
  expect(style.fontSize).toBe("12px");
  expect(style.fontFamily).not.toContain("JetBrains");
  expect(note.querySelector(".font-mono")).toBeNull();
  expect(note.getBoundingClientRect().height).toBeLessThanOrEqual(
    Number.parseFloat(style.lineHeight),
  );

  const setup = getComputedStyle(page.getByRole("button", { name: "Set up Houston" }).element());
  // The ghost recipe: transparent fill, a leading icon and the 22px compact height.
  expect(setup.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(setup.height).toBe("22px");
  expect(
    page.getByRole("button", { name: "Set up Houston" }).element().querySelector("svg"),
  ).not.toBeNull();
});

it("offers Start without a project as a ghost button in the action row", async () => {
  await page.viewport(1440, 900);
  state.providers = [provider("claudeAgent")];
  state.scratchEnvironmentId = "environment-local";
  await using _screen = await render(<NoProjectsHero />, { router: "/" });

  const add = page.getByRole("button", { name: "Add folder" }).element();
  const clone = page.getByRole("button", { name: "Clone a repository" }).element();
  const scratch = page.getByRole("button", { name: "Start without a project" }).element();
  expect(getComputedStyle(scratch).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(Math.round(scratch.getBoundingClientRect().top)).toBe(
    Math.round(add.getBoundingClientRect().top),
  );
  expect(scratch.getBoundingClientRect().left).toBeGreaterThan(clone.getBoundingClientRect().right);
  state.scratchEnvironmentId = null;
});
