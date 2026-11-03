import { useSyncExternalStore, type DragEvent } from "react";

/** The drag payload a sidebar row and a grid cell label both write. */
export const THREAD_DRAG_TYPE = "application/x-houston-thread";

export interface ThreadDragSource {
  /** The grid the row currently lives in; null for a thread no grid shows. */
  readonly gridId: string | null;
  readonly threadId: string;
  readonly environmentId: string;
  readonly projectId: string;
}

export interface ThreadDragHandleProps {
  draggable: boolean;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: (event: DragEvent<HTMLElement>) => void;
}

export interface ThreadDropTargetProps {
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}

let active: ThreadDragSource | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function beginThreadDrag(source: ThreadDragSource): void {
  active = source;
  emit();
}

export function endThreadDrag(): void {
  if (active === null) return;
  active = null;
  emit();
}

export function getThreadDragSource(): ThreadDragSource | null {
  return active;
}

function subscribeThreadDrag(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The drag in flight, shared by the sidebar and every grid so drop targets agree. */
export function useThreadDragSource(): ThreadDragSource | null {
  return useSyncExternalStore(subscribeThreadDrag, getThreadDragSource, () => null);
}

export function writeThreadDrag(dataTransfer: DataTransfer, source: ThreadDragSource): void {
  dataTransfer.setData(THREAD_DRAG_TYPE, JSON.stringify(source));
  dataTransfer.effectAllowed = "move";
}

function isThreadDragSource(value: unknown): value is ThreadDragSource {
  if (value === null || typeof value !== "object") return false;
  const parsed = value as Partial<Record<keyof ThreadDragSource, unknown>>;
  return (
    (parsed.gridId === null || typeof parsed.gridId === "string") &&
    typeof parsed.threadId === "string" &&
    typeof parsed.environmentId === "string" &&
    typeof parsed.projectId === "string"
  );
}

export function readThreadDrag(dataTransfer: DataTransfer): ThreadDragSource | null {
  const raw = dataTransfer.getData(THREAD_DRAG_TYPE);
  if (raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isThreadDragSource(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
