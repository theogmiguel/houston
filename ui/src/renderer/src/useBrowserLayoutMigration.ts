import { useEffect } from "react";
import type { Workspace } from "./houston/client";
import { browserTabUrl, loadInspectorTabs, saveInspectorTabs, saveBrowserTabUrl, isBrowserSurface, type SurfaceKind } from "./scmPanel";
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
      const state = loadInspectorTabs(workspace.path);
      for (const url of new Set(urls)) {
        if (state.openTabs.some((tab) => isBrowserSurface(tab) && browserTabUrl(workspace.path, tab.slice(8)) === url)) continue;
        const id = `layout-migration-${crypto.randomUUID()}`;
        const surface: SurfaceKind = `browser:${id}`;
        saveBrowserTabUrl(workspace.path, id, url);
        state.openTabs.push(surface);
        state.active = surface;
      }
      saveInspectorTabs(workspace.path, state);
      window.dispatchEvent(new Event('houston:inspector-restore'));
    }
  }, [workspaces, warmLayouts]);
}
