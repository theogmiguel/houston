import { useSyncExternalStore } from "react";

const KEY = "tr-rail-width";

// The rail's shipped width (`w-60`), so a fresh install looks unchanged until dragged.
export const RAIL_DEFAULT = 240;

// Below this every rail row truncates its label; 200px is the smallest that still reads.
export const RAIL_MIN = 200;

// A third of a 1366px screen; wider and the terminal grid stops being usable.
export const RAIL_MAX = 420;

// A drag under this collapses the rail; the stored width is what the expand button restores.
export const RAIL_COLLAPSE_AT = 160;

// Below this a chip's name never fits beside its dot, so rail rows go dot-only.
export const RAIL_TAG_DOT_AT = 240;

export function clampRailWidth(px: number): number {
  return Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(px)));
}

function load(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return RAIL_DEFAULT;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampRailWidth(parsed) : RAIL_DEFAULT;
  } catch {
    return RAIL_DEFAULT;
  }
}

function save(px: number): void {
  try {
    localStorage.setItem(KEY, String(px));
  } catch {
  }
}

let width: number = typeof localStorage !== "undefined" ? load() : RAIL_DEFAULT;
const listeners = new Set<() => void>();

export function setRailWidth(next: number): void {
  const clamped = clampRailWidth(next);
  if (clamped === width) return;
  width = clamped;
  save(clamped);
  for (const l of listeners) l();
}

export function resetRailWidthForTests(): void {
  width = RAIL_DEFAULT;
  for (const l of listeners) l();
}

export function useRailWidth(): number {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => width,
    () => RAIL_DEFAULT,
  );
}
