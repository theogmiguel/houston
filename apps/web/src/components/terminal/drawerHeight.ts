import { DEFAULT_THREAD_TERMINAL_HEIGHT } from "../../types";

// The drawer's height rules, shared with the placeholder that holds its place while it loads.
const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;

export interface DrawerLayout {
  viewportHeight: number;
  chatColumnHeight?: number;
  headerHeight?: number;
  composerHeight?: number;
}

export function resolveTerminalDrawerMaxHeight(input: DrawerLayout): number {
  const windowCap = Math.max(
    MIN_DRAWER_HEIGHT,
    Math.floor(input.viewportHeight * MAX_DRAWER_HEIGHT_RATIO),
  );
  if (input.chatColumnHeight === undefined) return windowCap;
  // The composer overlays the timeline, so flex layout cannot reserve its
  // height; without this cap a tall drawer pushes it into the header.
  return Math.min(
    windowCap,
    Math.max(0, input.chatColumnHeight - (input.headerHeight ?? 0) - (input.composerHeight ?? 0)),
  );
}

export function clampDrawerHeight(height: number, maxHeight: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.min(Math.max(Math.round(safeHeight), MIN_DRAWER_HEIGHT), maxHeight);
}

export function chatColumnOf(drawer: HTMLElement | null): HTMLElement | null {
  return drawer?.closest<HTMLElement>("[data-chat-column]") ?? null;
}

export function readDrawerLayout(column: HTMLElement | null): Omit<DrawerLayout, "composerHeight"> {
  const viewportHeight = typeof window === "undefined" ? 0 : window.innerHeight;
  if (!column) return { viewportHeight };
  return {
    viewportHeight,
    chatColumnHeight: column.clientHeight,
    headerHeight: column.querySelector<HTMLElement>("[data-chat-header]")?.offsetHeight ?? 0,
  };
}
