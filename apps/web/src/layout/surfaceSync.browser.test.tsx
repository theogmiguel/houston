import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock(import("../lib/terminalCloseConfirm"), () => ({
  confirmTerminalClose: async () => true,
  isTerminalCloseConfirmPending: () => false,
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));

import { render } from "../../test/render";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { closeThreadSurface, registerSurfaceResourceServices } from "./closeThreadSurface";
import { closeLayoutTabByUser, registerLayoutSurfaceCloser } from "./layoutActions";
import { buildLayout } from "./layoutFixtures";
import {
  findLayoutSurfaceTabs,
  findLayoutTab,
  THREAD_TERMINAL_SURFACE_ID,
  type LayoutState,
} from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { useLayoutSurfaceSync } from "./surfaceSync";

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("t1"));

function SyncHost() {
  useLayoutSurfaceSync();
  return null;
}

function seed(shape: string[][][][]) {
  useLayoutStore.getState().reset();
  useLayoutStore.getState().setLayoutFromServer(buildLayout(shape));
  useRightPanelStore.setState({ byThreadKey: {} });
  useTerminalUiStateStore.getState().clearTerminalUiState(threadRef);
}

const layout = (): LayoutState => useLayoutStore.getState().layout;
const surfaceIds = () =>
  findLayoutSurfaceTabs(layout(), threadRef).flatMap(({ tab }) =>
    tab.content.kind === "surface" ? [tab.content.surfaceId] : [],
  );

describe("surfaceSync", () => {
  // Runs first: the adoption of surfaces left open happens once per page load.
  it("turns surfaces that were open before the layout showed tabs into tabs", async () => {
    seed([[[["t1"]]]]);
    useRightPanelStore.getState().open(threadRef, "diff");
    useTerminalUiStateStore.getState().setTerminalOpen(threadRef, true);
    expect(surfaceIds()).toEqual([]);

    await using _host = await render(<SyncHost />);

    await vi.waitFor(() => {
      expect(surfaceIds()).toContain("diff");
      expect(surfaceIds()).toContain(THREAD_TERMINAL_SURFACE_ID);
    });
    expect(findLayoutTab(layout(), (tab) => tab.id === "t1")).not.toBeNull();
  });

  it("opens a surface as a tab beside its chat tab", async () => {
    seed([[[["t1"]]]]);
    await using _host = await render(<SyncHost />);

    useRightPanelStore.getState().open(threadRef, "diff");

    await vi.waitFor(() => expect(surfaceIds()).toEqual(["diff"]));
    expect(findLayoutTab(layout(), (tab) => tab.id === "t1")).not.toBeNull();
  });

  it("keeps a surface tab when its chat tab closes", async () => {
    seed([[[["t1", "t2"]]]]);
    await using _host = await render(<SyncHost />);
    useRightPanelStore.getState().open(threadRef, "diff");
    await vi.waitFor(() => expect(surfaceIds()).toEqual(["diff"]));

    useLayoutStore.getState().closeTab("t1");

    expect(findLayoutTab(layout(), (tab) => tab.id === "t1")).toBeNull();
    expect(surfaceIds()).toEqual(["diff"]);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).isOpen,
    ).toBe(true);
  });

  it("ends the terminal's sessions when its tab closes", async () => {
    seed([[[["t1"]]]]);
    const closeTerminalSession = vi.fn();
    using _services = {
      [Symbol.dispose]: registerSurfaceResourceServices({
        closeTerminalSession,
        releaseSurface: vi.fn(),
      }),
    };
    using _closer = { [Symbol.dispose]: registerLayoutSurfaceCloser(closeThreadSurface) };
    await using _host = await render(<SyncHost />);
    useTerminalUiStateStore
      .getState()
      .ensureTerminal(threadRef, "default", { open: true, active: true });
    await vi.waitFor(() => expect(surfaceIds()).toEqual([THREAD_TERMINAL_SURFACE_ID]));
    const terminalTab = findLayoutSurfaceTabs(layout(), threadRef)[0]!.tab;

    closeLayoutTabByUser(terminalTab.id);

    await vi.waitFor(() => expect(surfaceIds()).toEqual([]));
    expect(closeTerminalSession).toHaveBeenCalledWith(threadRef, "default");
  });

  it("keeps one tab per surface when the store opens it again", async () => {
    seed([[[["t1"]]]]);
    await using _host = await render(<SyncHost />);
    useRightPanelStore.getState().open(threadRef, "diff");
    await vi.waitFor(() => expect(surfaceIds()).toEqual(["diff"]));

    useRightPanelStore.getState().open(threadRef, "diff");
    useRightPanelStore.getState().open(threadRef, "files");

    await vi.waitFor(() => expect(surfaceIds().toSorted()).toEqual(["diff", "files"]));
  });

  it("points a folder's tab at the file that replaced it", async () => {
    seed([[[["t1"]]]]);
    await using _host = await render(<SyncHost />);
    useRightPanelStore.getState().open(threadRef, "files");
    await vi.waitFor(() => expect(surfaceIds()).toEqual(["files"]));
    const tabId = findLayoutSurfaceTabs(layout(), threadRef)[0]!.tab.id;

    useRightPanelStore.getState().navigateFolder(threadRef, "files", "src/a.ts", "src");

    await vi.waitFor(() => expect(surfaceIds()).toHaveLength(1));
    expect(surfaceIds()[0]).not.toBe("files");
    expect(findLayoutSurfaceTabs(layout(), threadRef)[0]!.tab.id).toBe(tabId);
  });
});
