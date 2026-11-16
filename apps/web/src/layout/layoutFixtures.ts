import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";

import type { LayoutState, LayoutTab, LayoutTabContent } from "./layoutModel";

const environmentId = EnvironmentId.make("local");

/** A chat tab whose id is the given name, so tests can address it. */
export function chatTab(name: string): LayoutTab {
  const content: LayoutTabContent = {
    kind: "chat",
    target: { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make(name)) },
  };
  return { id: name, content };
}

/**
 * A layout from workspaces of columns of panes of tab names: ids are `w<i>`, `w<i>c<j>` and
 * `w<i>c<j>p<k>`. Each pane shows its first tab, and the first pane of the first workspace has
 * focus. Panes of a column and columns of a workspace share their space equally.
 */
export function buildLayout(
  shape: readonly (readonly (readonly (readonly string[])[])[])[],
): LayoutState {
  const workspaces = shape.map((columns, w) => ({
    id: `w${w}`,
    name: `Workspace ${w + 1}`,
    cameraWidth: null,
    focusedPaneId: columns.length > 0 ? `w${w}c0p0` : null,
    columns: columns.map((panes, c) => ({
      id: `w${w}c${c}`,
      width: 1 / columns.length,
      panes: panes.map((tabs, p) => ({
        id: `w${w}c${c}p${p}`,
        size: 1 / panes.length,
        activeTabId: tabs[0] ?? null,
        tabs: tabs.map(chatTab),
      })),
    })),
  }));
  return { workspaces, focusedWorkspaceId: "w0" };
}
