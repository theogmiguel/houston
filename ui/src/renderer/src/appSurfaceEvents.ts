import { isLive } from "./houston/client";
import type { HoustonClient, KeymapOverrides, SessionInfo, ServerMsg, Workspace } from "./houston/client";
import { basename } from "./editor/bufferStore";
import {
  openBrowserSurface,
  openDiffSurface,
  openFilesSurface,
  openLinkedPullRequestsSurface,
  openPullRequestSurface,
  openPullRequestsScreen,
  reorderCardNext,
  reorderCardPrev,
  resolveGlobalMatch,
} from "./keymap";

type PanelSurface = "browser" | "files" | "diff" | "pull-request" | "linked-pull-requests";

export function handleSurfaceShortcut(
  event: KeyboardEvent,
  keymapOverrides: KeymapOverrides,
  layerArmed: boolean,
  openPanelSurface: (surface: PanelSurface) => void,
  openPullRequests: () => void,
): boolean {
  if (layerArmed) {
    const surfaces = [
      [openBrowserSurface, "browser"],
      [openFilesSurface, "files"],
      [openDiffSurface, "diff"],
      [openPullRequestSurface, "pull-request"],
      [openLinkedPullRequestsSurface, "linked-pull-requests"],
    ] as const;
    const match = surfaces.find(([shortcut]) => resolveGlobalMatch(shortcut, keymapOverrides)(event));
    if (match) {
      event.preventDefault();
      openPanelSurface(match[1]);
      return true;
    }
    if (resolveGlobalMatch(openPullRequestsScreen, keymapOverrides)(event)) {
      event.preventDefault();
      openPullRequests();
      return true;
    }
  }
  const previous = resolveGlobalMatch(reorderCardPrev, keymapOverrides)(event);
  const next = !previous && resolveGlobalMatch(reorderCardNext, keymapOverrides)(event);
  if (!previous && !next) return false;
  event.preventDefault();
  window.dispatchEvent(new CustomEvent("houston:rail-reorder-selected-card", {
    detail: { direction: previous ? -1 : 1 },
  }));
  return true;
}

export function handleQuickOpenShortcut(
  event: KeyboardEvent,
  selectedWorkspace: string,
  openQuickOpen: () => void,
): boolean {
  const target = event.target instanceof Element ? event.target : null;
  const terminalFocused = Boolean(target?.closest('[aria-label="Terminal input"], .term-host textarea'));
  if (terminalFocused || (!event.ctrlKey && !event.metaKey) || event.key.toLowerCase() !== "p" || event.altKey) return false;
  if (selectedWorkspace === "all") return false;
  event.preventDefault();
  openQuickOpen();
  return true;
}

export function focusAndFlashPane(session: number, focusPane: (session: number) => void): void {
  focusPane(session);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const pane = document.querySelector<HTMLElement>(`.pane[data-panekey="${session}"]`);
    pane?.animate(
      [
        { outline: "2px solid var(--accent)", outlineOffset: "-2px" },
        { outline: "2px solid transparent", outlineOffset: "-2px" },
      ],
      { duration: 650, easing: "cubic-bezier(0.22,1,0.36,1)" },
    );
  }));
}

export function pasteToAgent(
  client: HoustonClient | null,
  sessions: { readonly current: ReadonlyMap<number, SessionInfo> },
  session: number,
  text: string,
  pushError: (message: string) => void,
): void {
  const target = sessions.current.get(session);
  if (!client || !target || !isLive(target.state)) return;
  if (!client.sendStdin(session, `\x1b[200~${text}\x1b[201~`)) {
    pushError(`connection lost — prompt was not pasted to session ${session}`);
  }
}

export function handlePullRequestWireMessage(
  message: ServerMsg,
  handleMessage: (message: Extract<ServerMsg, { type: "pr_list" }>) => void,
): boolean {
  if (message.type !== "pr_list") return false;
  handleMessage(message);
  return true;
}

export function pullRequestRepositoryName(workspaces: readonly Workspace[], directory: string | null | undefined): string {
  return workspaces.find((workspace) => workspace.path === directory)?.name ??
    (directory ? basename(directory) : "Pull Requests");
}

export function pullRequestWorkspace(directory: string | null | undefined): string {
  return directory ?? "all";
}
