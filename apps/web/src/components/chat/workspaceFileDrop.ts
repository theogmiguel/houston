import { isFileTransfer, transferredPaths } from "../../lib/fileTransfer";

interface WorkspaceFileDragEvent {
  readonly dataTransfer: {
    readonly types: ReadonlyArray<string>;
    readonly files: Iterable<File>;
    readonly items?: Iterable<{
      readonly kind: string;
      getAsFile(): File | null;
      webkitGetAsEntry(): { readonly isDirectory: boolean } | null;
    }>;
    dropEffect: string;
    getData(type: string): string;
  };
  readonly relatedTarget: EventTarget | null;
  readonly currentTarget: {
    contains(target: Node | null): boolean;
  };
  preventDefault(): void;
}

interface WorkspaceFileDropHost {
  setDragActive(active: boolean): void;
  addFiles(files: File[]): void;
  /** `paths` names the same dropped entries when the drag also carries `text/uri-list`. */
  addFolders(folders: File[], paths: readonly string[]): void;
  /** URI-list-only entries: their folder-or-file kind is unknown until the host reads them. */
  addDroppedPaths?(paths: readonly string[]): void;
}

function movedWithinDropTarget(event: WorkspaceFileDragEvent): boolean {
  return event.relatedTarget !== null && event.currentTarget.contains(event.relatedTarget as Node);
}

export function splitTransferredFiles(
  dataTransfer: Pick<WorkspaceFileDragEvent["dataTransfer"], "files" | "items">,
): {
  files: File[];
  folders: File[];
} {
  if (dataTransfer.items === undefined)
    return { files: Array.from(dataTransfer.files), folders: [] };

  const files: File[] = [];
  const folders: File[] = [];
  for (const item of dataTransfer.items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file === null) continue;
    if (item.webkitGetAsEntry()?.isDirectory === true) {
      folders.push(file);
    } else {
      files.push(file);
    }
  }
  // WebKitGTK can populate `files` from the pasteboard while its item list stays empty, as it
  // does for an in-memory clipboard image. `files` is the same union of entries in that case.
  if (files.length === 0 && folders.length === 0) {
    return { files: Array.from(dataTransfer.files), folders: [] };
  }
  return { files, folders };
}

export function makeWorkspaceFileDropHandlers(host: WorkspaceFileDropHost) {
  return {
    onDragEnter(event: WorkspaceFileDragEvent) {
      if (!isFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      if (movedWithinDropTarget(event)) return;
      host.setDragActive(true);
    },
    onDragOver(event: WorkspaceFileDragEvent) {
      if (!isFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      host.setDragActive(true);
    },
    onDragLeave(event: WorkspaceFileDragEvent) {
      if (!isFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      if (movedWithinDropTarget(event)) return;
      host.setDragActive(false);
    },
    onDrop(event: WorkspaceFileDragEvent) {
      if (!isFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      host.setDragActive(false);
      const { files, folders } = splitTransferredFiles(event.dataTransfer);
      if (files.length > 0) host.addFiles(files);
      if (folders.length > 0 || files.length > 0) {
        if (folders.length > 0) host.addFolders(folders, transferredPaths(event.dataTransfer));
        return;
      }
      const paths = transferredPaths(event.dataTransfer);
      if (paths.length > 0) host.addDroppedPaths?.(paths);
    },
  };
}
