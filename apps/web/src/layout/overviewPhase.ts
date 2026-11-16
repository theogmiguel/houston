/**
 * The overview's phase and the module-level slots its camera, keys and pointer gestures share.
 * "opening" and "closing" are the two zooms; keys and clicks work from the keypress on.
 */
import { useSyncExternalStore } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { useLayoutStore } from "./layoutStore";
import { isLayoutModalOpen } from "./layoutKeyGuards";

export type OverviewPhase = "closed" | "opening" | "open" | "closing";

/** Where the strip was scrolled, which workspace it showed, and how far a switch had carried it. */
export interface OverviewEntryState {
  scrollLeft: number;
  workspaceId: string;
  rowOffset: number;
}

export interface OverviewCamera {
  pan: (x: number, y: number) => void;
  /** Returns outward travel past maximum zoom, as a scale factor. */
  zoom: (factor: number, x: number, y: number) => number;
}

let phase: OverviewPhase = "closed";
let entryState: OverviewEntryState = { scrollLeft: 0, workspaceId: "", rowOffset: 0 };
const phaseListeners = new Set<() => void>();
let camera: OverviewCamera | null = null;
let stopGesture: (() => void) | null = null;

export function getOverviewPhase(): OverviewPhase {
  return phase;
}

export function getOverviewEntry(): OverviewEntryState {
  return entryState;
}

export function setOverviewEntry(next: OverviewEntryState): void {
  entryState = next;
}

export function getOverviewCamera(): OverviewCamera | null {
  return camera;
}

export function setOverviewCamera(next: OverviewCamera | null): void {
  camera = next;
}

/** The background pan or pane drag in progress, ended (without its drop) when another starts. */
export function holdOverviewGesture(stop: () => void): void {
  stopGesture = stop;
}

export function releaseOverviewGesture(stop: () => void): void {
  if (stopGesture === stop) stopGesture = null;
}

export function endOverviewGesture(): void {
  stopGesture?.();
}

export function setOverviewPhase(next: OverviewPhase): void {
  if (phase === next) return;
  if (next === "closing" || next === "closed") stopGesture?.();
  phase = next;
  for (const listener of phaseListeners) listener();
}

function subscribePhase(listener: () => void): () => void {
  phaseListeners.add(listener);
  return () => {
    phaseListeners.delete(listener);
  };
}

/** Whether the stage shows: open, or zooming back in. */
export function useOverviewPhase(): OverviewPhase {
  return useSyncExternalStore(subscribePhase, () => phase);
}

/**
 * Keys and clicks work from the keypress on, not while zooming back in.
 * The camera (wheel, pinch, drag) waits for the zoom to land.
 */
export function isOverviewInteractive(): boolean {
  return !isLayoutModalOpen() && (phase === "open" || phase === "opening");
}

export function requestOverviewOpen(open: boolean): void {
  useLayoutStore.getState().setOverviewOpen(open);
}

/** True while something above the overview owns the keyboard. */
export function overviewKeysSuspended(): boolean {
  return isCommandPaletteOpen() || isLayoutModalOpen();
}
