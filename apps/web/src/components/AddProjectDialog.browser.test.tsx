import type { SourceControlDiscoveryResult } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../test/render";

const state = vi.hoisted(() => ({
  discovery: null as SourceControlDiscoveryResult | null,
  environments: [] as ReadonlyArray<unknown>,
}));

const openCommandPalette = vi.fn();
vi.mock(import("../commandPaletteBus"), () => ({
  openCommandPalette: (input: unknown) => openCommandPalette(input),
  isCommandPaletteOpen: () => true,
}));
vi.mock(import("../state/sourceControl"), () => ({
  sourceControlEnvironment: {
    discovery: (input: unknown) => ({ mockDiscovery: input }),
  } as never,
}));
vi.mock(import("../state/query"), () => ({
  useEnvironmentQuery: () => ({ data: state.discovery, isLoading: false }) as never,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: state.environments })) as never,
  usePrimaryEnvironmentId: (() => "local") as never,
}));

import { AddProjectDialogHost, openAddProjectDialog } from "./AddProjectDialog";

const LOCAL_ENVIRONMENT = {
  environmentId: "local",
  label: "Local",
  connection: { phase: "connected" },
  entry: { target: { _tag: "PrimaryConnectionTarget" } },
  serverConfig: null,
};

function discovery(
  providers: ReadonlyArray<Record<string, unknown>>,
): SourceControlDiscoveryResult {
  return {
    versionControlSystems: [],
    sourceControlProviders: providers,
  } as unknown as SourceControlDiscoveryResult;
}

function resetDialogState(): void {
  openCommandPalette.mockReset();
  state.discovery = null;
  state.environments = [LOCAL_ENVIRONMENT];
}

describe("AddProjectDialog", () => {
  it("offers three actions and starts the chosen flow", async () => {
    resetDialogState();
    await using _screen = await render(<AddProjectDialogHost />);
    await act(() => openAddProjectDialog());

    await expect.element(page.getByRole("button", { name: /Open folder/ })).toBeVisible();
    await expect.element(page.getByRole("button", { name: /Clone repository/ })).toBeVisible();
    await expect.element(page.getByRole("button", { name: /New project/ })).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: /Open folder/ }));
    expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({
      open: "add-project",
      addProject: { action: "open-folder" },
    });

    await act(() => openAddProjectDialog());
    await userEvent.click(page.getByRole("button", { name: /Clone repository/ }));
    expect(openCommandPalette).toHaveBeenLastCalledWith({
      open: "add-project",
      addProject: { action: "clone" },
    });

    await act(() => openAddProjectDialog());
    await userEvent.click(page.getByRole("button", { name: /New project/ }));
    expect(openCommandPalette).toHaveBeenLastCalledWith({
      open: "add-project",
      addProject: { action: "new-project" },
    });
  });

  it("lists only configured integrations and links to provider settings", async () => {
    resetDialogState();
    state.discovery = discovery([
      {
        kind: "github",
        label: "GitHub",
        status: "available",
        installHint: "",
        auth: { status: "authenticated" },
      },
      {
        kind: "gitlab",
        label: "GitLab",
        status: "missing",
        installHint: "Install the GitLab CLI",
        auth: { status: "unauthenticated" },
      },
    ]);
    await using _screen = await render(<AddProjectDialogHost />);
    await act(() => openAddProjectDialog());

    const github = page.getByRole("button", { name: "GitHub" }).element();
    expect(github.hasAttribute("data-add-project-integration")).toBe(true);
    expect(page.getByRole("button", { name: "GitLab" }).elements()).toHaveLength(0);

    await userEvent.click(github);
    expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({
      open: "add-project",
      addProject: { action: "clone", environmentId: "local", source: "github" },
    });

    await act(() => openAddProjectDialog());
    const settings = page.getByRole("link", { name: "Connect a provider" }).element();
    expect(settings.getAttribute("href")).toBe("/settings/source-control");
  });

  it("shows only the settings link when no integration is configured", async () => {
    resetDialogState();
    state.discovery = discovery([]);
    await using _screen = await render(<AddProjectDialogHost />);
    await act(() => openAddProjectDialog());

    expect(page.getByRole("button", { name: "GitHub" }).elements()).toHaveLength(0);
    await expect.element(page.getByRole("link", { name: "Connect a provider" })).toBeVisible();
  });

  it("focuses the first card, moves with arrows and activates with Enter", async () => {
    resetDialogState();
    await using _screen = await render(<AddProjectDialogHost />);
    await act(() => openAddProjectDialog());

    await expect
      .poll(() => document.activeElement?.getAttribute("data-add-project-action"))
      .toBe("open-folder");
    await userEvent.keyboard("{ArrowRight}");
    await expect
      .poll(() => document.activeElement?.getAttribute("data-add-project-action"))
      .toBe("clone");
    await userEvent.keyboard("{Enter}");
    expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({
      open: "add-project",
      addProject: { action: "clone" },
    });
  });

  it("closes on Escape", async () => {
    resetDialogState();
    await using _screen = await render(<AddProjectDialogHost />);
    await act(() => openAddProjectDialog());
    await expect.element(page.getByRole("dialog", { name: "Add project" })).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog", { name: "Add project" })).not.toBeInTheDocument();
  });
});
