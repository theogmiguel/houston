type RenameListener = (threadId: string) => void;

const renameListeners = new Set<RenameListener>();

/** Asks the cell showing a thread to open its inline rename field. */
export function requestGridCellRename(threadId: string): void {
  for (const listener of renameListeners) listener(threadId);
}

export function subscribeGridCellRename(listener: RenameListener): () => void {
  renameListeners.add(listener);
  return () => {
    renameListeners.delete(listener);
  };
}
