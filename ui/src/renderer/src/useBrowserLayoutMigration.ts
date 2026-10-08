import { useEffect } from "react";
import type { Workspace } from "./houston/client";
import { loadSideState, saveSideState } from "./sidePanel";
import type { LayoutState } from "./layout/tree";

export function useBrowserLayoutMigration(
  workspaces: readonly Workspace[],
  warmLayouts: ReadonlyMap<string, LayoutState>,
): void {
  useEffect(() => {
    for (const workspace of workspaces) {
      const urls = [...warmLayouts.entries()]
        .filter(([key, layout]) => key.startsWith(`${workspace.path}::`) && layout.browserUrls?.length)
        .flatMap(([, layout]) => layout.browserUrls ?? []);
      if (urls.length === 0) continue;
      const state = loadSideState(workspace.path);
      let active = state.active;
      let nextId = 0;
      for (const url of new Set(urls)) {
        const existing = state.tabs.findIndex((tab) => tab.kind === "browser" && tab.url === url);
        if (existing >= 0) {
          active = existing;
          continue;
        }
        state.tabs.push({ kind: "browser", id: `layout-migration-${Date.now()}-${nextId++}`, url });
        active = state.tabs.length - 1;
      }
      if (active !== state.active) saveSideState(workspace.path, { ...state, active });
    }
  }, [workspaces, warmLayouts]);
}
