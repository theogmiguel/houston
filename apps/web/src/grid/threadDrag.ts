import { useSyncExternalStore, type DragEvent } from "react";

/** The drag payload a sidebar row and a grid cell label both write. */
export const THREAD_DRAG_TYPE = "application/x-houston-thread";

export interface ThreadDragSource {
  readonly gridId: string;
  readonly threadId: string;
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

export function hasThreadDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(THREAD_DRAG_TYPE);
}

export function writeThreadDrag(dataTransfer: DataTransfer, source: ThreadDragSource): void {
  dataTransfer.setData(THREAD_DRAG_TYPE, JSON.stringify(source));
  dataTransfer.effectAllowed = "move";
}

export function readThreadDrag(dataTransfer: DataTransfer): ThreadDragSource | null {
  const raw = dataTransfer.getData(THREAD_DRAG_TYPE);
  if (raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ThreadDragSource>;
    if (typeof parsed.gridId !== "string" || typeof parsed.threadId !== "string") return null;
    return { gridId: parsed.gridId, threadId: parsed.threadId };
  } catch {
    return null;
  }
}
