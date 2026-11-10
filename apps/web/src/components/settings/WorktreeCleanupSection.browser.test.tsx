import { DEFAULT_SERVER_SETTINGS } from "@houston-app/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { WorktreeCleanupSection } from "./StorageSettings";

const environment = {
  environmentId: "env-a",
  label: "env-a",
  serverConfig: {
    settings: DEFAULT_SERVER_SETTINGS,
    environment: {
      capabilities: { storageCleanup: true, storageCleanupRun: true, settledWorktreeCleanup: true },
    },
  },
};
const target = {
  environmentId: "env-a",
  projectId: null,
  settings: DEFAULT_SERVER_SETTINGS,
  sources: {},
};

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all" },
    environments: [environment],
    connectedEnvironments: [environment],
    targets: [target],
    target: null,
  })) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => DEFAULT_SERVER_SETTINGS) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => vi.fn(),
  useClearScopedSettings: () => vi.fn(),
}));

// The real row makes a serverScoped control inert without a write grant, which this test does not model.
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: (({ title, description, control }: Record<string, ReactNode>) => (
    <div>
      <h3>{title}</h3>
      {description}
      {control}
    </div>
  )) as never,
}));

describe("WorktreeCleanupSection", () => {
  it("names the automatic cleanup choice for what it acts on: deleted threads", async () => {
    await using screen = await render(<WorktreeCleanupSection />);

    await screen.getByRole("combobox", { name: "Worktree cleanup" }).click();

    await expect.element(screen.getByRole("option", { name: "When deleted" })).toBeVisible();
    expect(screen.getByRole("option", { name: "When archived" }).elements()).toHaveLength(0);
  });

  it("offers a single control for keeping worktrees with local changes", async () => {
    await using screen = await render(<WorktreeCleanupSection />);

    await expect
      .element(screen.getByRole("combobox", { name: "Keep worktrees with local changes" }))
      .toBeVisible();
    expect(
      screen.getByRole("switch", { name: "Keep worktrees with local changes" }).elements(),
    ).toHaveLength(0);
  });
});
