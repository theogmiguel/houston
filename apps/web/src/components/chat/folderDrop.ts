import type { EnvironmentId } from "@houston-app/contracts";

export function folderDropTarget(input: {
  localEnvironmentDisabled: boolean;
  environmentId: EnvironmentId;
  primaryEnvironmentId: EnvironmentId | null;
}): "local" | "remote" {
  if (
    input.localEnvironmentDisabled ||
    input.primaryEnvironmentId === null ||
    input.environmentId !== input.primaryEnvironmentId
  ) {
    return "remote";
  }
  return "local";
}

/** A URI-list entry's last segment, used to pair it with the folder File of the same name. */
function pathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

/**
 * WebKitGTK File objects carry no path, so a drag that also advertises `text/uri-list` is the only
 * source of the folder's real path. Entries and folders share the drag's order; a name match keeps
 * a mixed file-and-folder drag aligned.
 */
export function resolveDroppedFolderPaths(
  folders: readonly File[],
  paths: readonly string[],
  getPathForFile: ((file: File) => string) | undefined,
): (string | null)[] {
  return folders.map((folder, index) => {
    const nativePath = getPathForFile?.(folder);
    if (typeof nativePath === "string" && nativePath.length > 0) return nativePath;
    const byName = paths.find((path) => pathBasename(path) === folder.name);
    if (byName !== undefined) return byName;
    return paths.length === folders.length ? (paths[index] ?? null) : null;
  });
}
