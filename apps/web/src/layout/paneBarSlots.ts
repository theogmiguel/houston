import { useSyncExternalStore, type RefObject } from "react";

/**
 * The trailing end of each pane's tab bar, where the chat in the pane's active tab draws its
 * one control. The bar registers its slot by pane id; the chat, which lives elsewhere in the
 * tree, reads it and portals into it.
 */
const slots = new Map<string, HTMLElement>();
const anchors = new Map<string, { current: HTMLElement | null }>();
const listeners = new Set<() => void>();

const anchorOf = (paneId: string): { current: HTMLElement | null } => {
  const existing = anchors.get(paneId);
  if (existing) return existing;
  const created: { current: HTMLElement | null } = { current: null };
  anchors.set(paneId, created);
  return created;
};

/** Called by the pane's tab bar with its slot element, and with `null` when it unmounts. */
export function registerPaneBarSlot(paneId: string, element: HTMLElement | null): void {
  if (element === null) {
    if (!slots.delete(paneId)) return;
    anchorOf(paneId).current = null;
  } else {
    if (slots.get(paneId) === element) return;
    slots.set(paneId, element);
    // The popover anchors to the bar as a whole, so the card hangs from the pane's top edge.
    anchorOf(paneId).current = element.closest<HTMLElement>("[data-layout-tab-bar]") ?? element;
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The pane's bar slot, or `null` outside a layout pane or before the bar mounts. */
export function usePaneBarSlot(paneId: string | null): HTMLElement | null {
  return useSyncExternalStore(
    subscribe,
    () => (paneId === null ? null : (slots.get(paneId) ?? null)),
    () => null,
  );
}

/** A stable ref whose `current` is the pane's tab bar once it has mounted. */
export function paneBarAnchor(paneId: string | null): RefObject<HTMLElement | null> | null {
  return paneId === null ? null : anchorOf(paneId);
}
