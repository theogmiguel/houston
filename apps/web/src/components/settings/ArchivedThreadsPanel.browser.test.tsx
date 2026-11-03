import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { ArchivedThreadsPanel } from "./ArchivedThreadsPanel";

const state = vi.hoisted(() => ({
  isLoading: false,
  error: null as string | null,
}));

vi.mock(import("../../lib/archivedThreadsState"), async (original) => ({
  ...(await original()),
  useArchivedThreadSnapshots: (() => ({
    snapshots: [],
    error: state.error,
    isLoading: state.isLoading,
    refresh: () => {},
  })) as never,
}));
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => undefined) as never,
}));
vi.mock(import("../../hooks/useThreadActions"), async (original) => ({
  ...(await original()),
  useThreadActions: (() => ({
    unarchiveThread: vi.fn(),
    confirmAndDeleteThread: vi.fn(),
  })) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", label: "All", members: [], environmentIds: [] },
    groups: [],
    environments: [],
  })) as never,
}));

function setup() {
  state.isLoading = false;
  state.error = null;
}

describe("ArchivedThreadsPanel", () => {
  it("shows the page empty state when nothing is archived", async () => {
    setup();
    await using screen = await render(<ArchivedThreadsPanel />);
    await expect.element(screen.getByText("No archived threads")).toBeVisible();
    await expect
      .element(
        screen.getByText(
          "Threads you archive stay searchable here and can be restored at any time.",
        ),
      )
      .toBeVisible();
    await expect.element(screen.getByText("Archive a thread")).toBeVisible();
    await expect.element(screen.getByText("Restore anytime")).toBeVisible();
  });

  it("keeps the loading state while archived threads load", async () => {
    setup();
    state.isLoading = true;
    await using screen = await render(<ArchivedThreadsPanel />);
    await expect.element(screen.getByText("Loading archived threads")).toBeVisible();
    await expect.element(screen.getByText("No archived threads")).not.toBeInTheDocument();
  });

  it("shows the failure with its message when archived threads cannot load", async () => {
    setup();
    state.error = "The connection dropped.";
    await using screen = await render(<ArchivedThreadsPanel />);
    await expect.element(screen.getByText("Could not load archived threads")).toBeVisible();
    await expect.element(screen.getByText("The connection dropped.")).toBeVisible();
    await expect.element(screen.getByText("No archived threads")).not.toBeInTheDocument();
  });
});
