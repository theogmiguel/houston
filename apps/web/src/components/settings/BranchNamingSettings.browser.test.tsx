import { DEFAULT_UNIFIED_SETTINGS, type BranchNamingMode } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { WorktreeBranchNamingRow } from "./BranchNamingSettings";

const state = vi.hoisted(() => ({ mode: "static" as BranchNamingMode, modeMixed: false }));

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({ targets: [] })) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    branchNamingMode: state.mode,
  })) as never,
  useScopedSettingsMixed: ((keys: readonly string[]) =>
    keys.includes("branchNamingMode") && state.modeMixed) as never,
  useUpdateScopedSettings: (() => vi.fn()) as never,
}));

describe("WorktreeBranchNamingRow", () => {
  it("shows the prefix field in static mode, the only mode that reads the prefix", async () => {
    state.mode = "static";
    state.modeMixed = false;
    await using screen = await render(<WorktreeBranchNamingRow />);

    await expect.element(screen.getByLabelText("Worktree branch naming")).toBeVisible();
  });

  it.each(["semantic", "custom"] as const)("hides the prefix field in %s mode", async (mode) => {
    state.mode = mode;
    state.modeMixed = false;
    await using screen = await render(<WorktreeBranchNamingRow />);

    expect(screen.getByLabelText("Worktree branch naming").elements()).toHaveLength(0);
  });

  it("hides the prefix field when the selected machines disagree on the mode", async () => {
    state.mode = "static";
    state.modeMixed = true;
    await using screen = await render(<WorktreeBranchNamingRow />);

    expect(screen.getByLabelText("Worktree branch naming").elements()).toHaveLength(0);
  });
});
