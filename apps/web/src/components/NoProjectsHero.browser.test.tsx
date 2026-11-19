import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@houston-app/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../test/render";
import type { Houston1ImportStatuses } from "./settings/houston1Import.logic";
import { NoProjectsHero, providerStatusLine } from "./NoProjectsHero";

const NO_HOUSTON_1: Houston1ImportStatuses = {
  tasks: { state: "unavailable" },
  issues: null,
  slack: null,
};

const state = vi.hoisted(() => ({ providers: [] as ServerProvider[] }));
const houston1 = vi.hoisted(() => ({
  value: {
    statuses: {
      tasks: { state: "unavailable" },
      issues: null,
      slack: null,
    } as Houston1ImportStatuses,
    steps: [] as string[],
    visible: false,
    description: "",
    busy: false,
    failure: null as string | null,
  },
  run: vi.fn(async () => {}),
}));
const addProject = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: (() => new Map()) as never,
  usePrimaryEnvironmentId: () => "local" as never,
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
vi.mock(import("./settings/useHouston1Import"), () => ({
  useHouston1Import: (() => ({ ...houston1.value, run: houston1.run })) as never,
}));
vi.mock(import("./AddProjectDialog"), () => ({
  openAddProjectDialog: (options?: unknown) => addProject.open(options),
}));

function resetHouston1(): void {
  houston1.value = {
    statuses: NO_HOUSTON_1,
    steps: [],
    visible: false,
    description: "",
    busy: false,
    failure: null,
  };
  houston1.run.mockClear();
}

function availableHouston1(workspaceCount: number): void {
  houston1.value = {
    statuses: {
      tasks: {
        state: "available",
        source: "/home/x/.houston/houston.db",
        taskCount: 3,
        workspaceCount,
      },
      issues: null,
      slack: null,
    },
    steps: ["tasks"],
    visible: true,
    description: `Houston can copy ${workspaceCount} ${workspaceCount === 1 ? "project" : "projects"} and 3 tasks from Houston 1.`,
    busy: false,
    failure: null,
  };
  houston1.run.mockClear();
}

function resetHeroState() {
  resetHouston1();
  addProject.open.mockClear();
}

function renderHero() {
  return render(<NoProjectsHero />, { router: "/" });
}

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
  resetHeroState();
  state.providers = [
    provider("claudeAgent"),
    provider("codex"),
    missing("opencode"),
    missing("cursor"),
  ];
  await using _screen = await renderHero();

  const line = page.getByRole("button", { name: "Claude Code and Codex ready · 2 not installed" });
  await expect.element(line).toBeVisible();
  // No per-provider rows: the detail lives on the settings page the line opens.
  expect(page.getByText("1.0.0 · signed in").elements()).toHaveLength(0);
  expect(page.getByRole("button", { name: "How to install" }).elements()).toHaveLength(0);
});

it("says when a provider needs attention instead of reporting everything ready", async () => {
  resetHeroState();
  state.providers = [
    provider("claudeAgent"),
    provider("codex", { auth: { status: "unauthenticated" } }),
  ];
  await using _screen = await renderHero();

  await expect.element(page.getByText("Claude Code ready · 1 needs attention")).toBeVisible();
});

it("describes the status line for every mix of provider states", () => {
  resetHeroState();
  expect(providerStatusLine([])).toBe("No providers found");
  expect(providerStatusLine([provider("claudeAgent"), provider("codex"), provider("grok")])).toBe(
    "3 providers ready",
  );
  expect(providerStatusLine([missing("opencode")])).toBe("1 not installed");
});

it("calls folders projects instead of Houston 1 workspaces", async () => {
  resetHeroState();
  state.providers = [provider("claudeAgent")];
  await using _screen = await renderHero();

  await expect
    .element(
      page.getByText(
        "A project is a folder on this machine. Its threads run on Houston's local server and keep running when you close the window.",
      ),
    )
    .toBeVisible();
  expect(document.querySelector("main")!.textContent).not.toContain("workspace");
});

it("keeps Add folder the dominant action above the status line", async () => {
  resetHeroState();
  state.providers = [provider("claudeAgent"), missing("opencode")];
  await using _screen = await renderHero();

  const add = page.getByRole("button", { name: "Add folder" }).element();
  const line = page.getByRole("button", { name: /Claude Code ready/ }).element();
  expect(add.getBoundingClientRect().bottom).toBeLessThan(line.getBoundingClientRect().top);
  expect(getComputedStyle(add).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
});

it("puts the network note and setup behind an info button instead of on the page", async () => {
  resetHeroState();
  state.providers = [provider("claudeAgent")];
  await using _screen = await renderHero();

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
  resetHeroState();
  state.providers = [provider("claudeAgent")];
  await using _screen = await renderHero();

  const main = document.querySelector<HTMLElement>("main")!;
  // Add folder, Clone a repository, the status line and the info button; no scratch target here.
  expect(main.querySelectorAll("button")).toHaveLength(4);
  await expect.element(page.getByText(/A project is a folder on this machine/)).toBeVisible();
});

it("offers to import Houston 1 projects from the first screen", async () => {
  resetHeroState();
  availableHouston1(2);
  state.providers = [provider("claudeAgent")];
  await using _screen = await renderHero();

  const button = page.getByRole("button", { name: "Import 2 projects from Houston 1" });
  await expect.element(button).toBeVisible();
  await expect.element(page.getByText(/Houston can copy 2 projects and 3 tasks/)).toBeVisible();

  const importButton = button.element();
  const addFolder = page.getByRole("button", { name: "Add folder" }).element();
  expect(getComputedStyle(importButton).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(getComputedStyle(addFolder).backgroundColor).not.toBe(
    getComputedStyle(importButton).backgroundColor,
  );

  await userEvent.click(button);
  expect(houston1.run).toHaveBeenCalledOnce();
});

it("says project in the singular for one Houston 1 project", async () => {
  resetHeroState();
  availableHouston1(1);
  state.providers = [provider("claudeAgent")];
  await using _screen = await renderHero();

  await expect
    .element(page.getByRole("button", { name: "Import 1 project from Houston 1" }))
    .toBeVisible();
});

it("hides the import while it runs and says so", async () => {
  resetHeroState();
  availableHouston1(2);
  houston1.value = { ...houston1.value, busy: true };
  state.providers = [provider("claudeAgent")];
  await using _screen = await renderHero();

  const button = page.getByRole("button", { name: "Importing…" });
  await expect.element(button).toBeVisible();
  expect(button.element().hasAttribute("disabled")).toBe(true);
});

it("does not offer the import when Houston 1 has no projects", async () => {
  resetHeroState();
  availableHouston1(0);
  state.providers = [provider("claudeAgent")];
  await using _screen = await renderHero();

  expect(page.getByRole("button", { name: /from Houston 1/ }).elements()).toHaveLength(0);
});

it("shows the server's message when the Houston 1 import fails", async () => {
  resetHeroState();
  availableHouston1(2);
  houston1.value = { ...houston1.value, failure: "Houston 1's database is locked." };
  state.providers = [provider("claudeAgent")];
  await using _screen = await renderHero();

  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Houston 1's database is locked.");
});

it("opens the folder and clone flows directly", async () => {
  resetHeroState();
  state.providers = [provider("claudeAgent")];
  await using _screen = await renderHero();

  await userEvent.click(page.getByRole("button", { name: "Add folder" }));
  expect(addProject.open).toHaveBeenLastCalledWith({ action: "open-folder" });

  await userEvent.click(page.getByRole("button", { name: "Clone a repository" }));
  expect(addProject.open).toHaveBeenLastCalledWith({ action: "clone" });
});

it("leaves the header breadcrumb slot empty", async () => {
  resetHeroState();
  state.providers = [provider("claudeAgent")];
  await using screen = await renderHero();

  const header = screen.container.querySelector("header")!;
  expect(header.textContent).toBe("");
});
