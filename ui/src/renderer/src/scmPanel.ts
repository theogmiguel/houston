import { useSyncExternalStore } from "react";

const WIDTH_KEY = "tr-scm-width";
const OPEN_KEY = "tr-scm-open";

// The approved opening width; a fresh install sees the panel at this size.
export const SCM_WIDTH_DEFAULT = 480;

// The compact floor: below this the file list, the diff and the commit row
// stop fitting the panel, so a drag cannot make it smaller.
export const SCM_WIDTH_MIN = 340;

// The terminal grid keeps at least this much, so widening the panel never
// swallows the panes the panel exists to review.
export const SCM_TERMINAL_FLOOR = 360;

// 4% of the host span per arrow press — the terminal splitter's own step, so
// the two dividers answer the keyboard identically.
export const SCM_KEY_STEP = 0.04;

function sanitize(px: number): number {
  return Number.isFinite(px) ? Math.round(px) : SCM_WIDTH_DEFAULT;
}

export function scmWidthMax(hostWidth: number): number {
  if (!(hostWidth > 0)) return SCM_WIDTH_DEFAULT;
  return Math.min(hostWidth, Math.max(SCM_WIDTH_MIN, hostWidth - SCM_TERMINAL_FLOOR));
}

// The requested width is what the user asked for; this is what fits right now.
// The requested value is never overwritten by a viewport clamp, so widening
// the window restores the size the user chose (the rail's own contract).
export function clampScmWidth(requested: number, hostWidth: number): number {
  const wanted = sanitize(requested);
  if (!(hostWidth > 0)) return Math.max(SCM_WIDTH_MIN, wanted);
  const upper = scmWidthMax(hostWidth);
  const lower = Math.min(SCM_WIDTH_MIN, upper);
  return Math.max(lower, Math.min(upper, wanted));
}

export function stepScmWidth(width: number, dir: 1 | -1, hostWidth: number): number {
  const span = hostWidth > 0 ? hostWidth : SCM_WIDTH_DEFAULT;
  return clampScmWidth(width + dir * span * SCM_KEY_STEP, hostWidth);
}

function loadWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : SCM_WIDTH_DEFAULT;
  } catch {
    return SCM_WIDTH_DEFAULT;
  }
}

function saveWidth(px: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(px));
  } catch {
  }
}

let width: number = typeof localStorage !== "undefined" ? loadWidth() : SCM_WIDTH_DEFAULT;
const listeners = new Set<() => void>();

export function setScmWidth(next: number): void {
  const sanitized = sanitize(next);
  if (sanitized === width) return;
  width = sanitized;
  saveWidth(width);
  for (const l of listeners) l();
}

export function resetScmWidthForTests(): void {
  width = SCM_WIDTH_DEFAULT;
  for (const l of listeners) l();
}

export function useScmWidth(): number {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => width,
    () => SCM_WIDTH_DEFAULT
  );
}

export function loadScmOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveScmOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
  }
}

type SessionRepo = { project_dir: string };

export function focusedRepoDir(
  sessions: ReadonlyMap<number, SessionRepo>,
  activeId: number | null
): string | null {
  return activeId === null ? null : (sessions.get(activeId)?.project_dir ?? null);
}

export function scmWorkspace(
  selectedWs: string,
  focusedDir: string | null
): string | null {
  return selectedWs === "all" ? focusedDir : selectedWs;
}

export type ScmTab = "changes" | "pull-request";

export function scmTabLabel(tab: ScmTab): string {
  return tab === "changes" ? "Changes" : "Pull request";
}

const DRAFT_PREFIX = "tr-scm-draft:";

// The unsent commit message survives a panel close or a workspace switch: it
// is keyed by repo, and an empty message removes the key rather than storing
// one, so a successful commit leaves nothing behind.
export function loadScmDraft(dir: string): string {
  try {
    return localStorage.getItem(DRAFT_PREFIX + dir) ?? "";
  } catch {
    return "";
  }
}

export function saveScmDraft(dir: string, message: string): void {
  try {
    if (message.length === 0) localStorage.removeItem(DRAFT_PREFIX + dir);
    else localStorage.setItem(DRAFT_PREFIX + dir, message);
  } catch {
  }
}
