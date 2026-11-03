/** Newline-separated absolute paths that Houston's own drag sources advertise. */
export const FILE_PATH_MIME = "application/x-file-path";
/** RFC 2483; what GTK file managers put on a drag or copy. */
export const URI_LIST_MIME = "text/uri-list";
/** GNOME's file-manager flavor: an action line followed by file URIs. */
export const GNOME_COPIED_FILES_MIME = "x-special/gnome-copied-files";

export interface FileTransferData {
  readonly types: ReadonlyArray<string>;
  readonly files?: Iterable<File> | null;
  readonly items?: Iterable<{ readonly kind: string }> | null;
  getData(type: string): string;
}

/**
 * Types-only gate. Deliberately optimistic: a false accept costs one empty drop, a false reject
 * lets WebKitGTK navigate the webview to the file. `items[].kind` still works when types are hidden.
 */
export function isFileTransfer(data: FileTransferData | null | undefined): boolean {
  if (!data) return false;
  const types = Array.from(data.types ?? []);
  if (
    types.includes("Files") ||
    types.includes(FILE_PATH_MIME) ||
    types.includes(URI_LIST_MIME) ||
    types.includes(GNOME_COPIED_FILES_MIME)
  ) {
    return true;
  }
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file") return true;
  }
  return false;
}

/**
 * Per RFC 2483 a `#`-prefixed line is a comment, and non-`file:` URIs are dropped because they
 * name nothing on disk. The leading-slash strip handles Windows' `file:///C:/x`.
 */
export function parseUriList(text: string): string[] {
  if (!text) return [];
  const paths: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let parsed: URL;
    try {
      parsed = new URL(line);
    } catch {
      continue;
    }
    if (parsed.protocol !== "file:") continue;
    let path: string;
    try {
      path = decodeURIComponent(parsed.pathname);
    } catch {
      continue;
    }
    if (path.startsWith("/") && /^[A-Za-z]:/.test(path.slice(1))) path = path.slice(1);
    if (path) paths.push(path);
  }
  return paths;
}

/** The clipboard flavor starts with `copy` or `cut` on its own line, then the URI list. */
export function parseGnomeCopiedFiles(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  const first = lines[0]?.trim().toLowerCase();
  return parseUriList((first === "copy" || first === "cut" ? lines.slice(1) : lines).join("\n"));
}

/** Some engines throw for a flavor the transfer does not advertise instead of returning "". */
function readFlavor(data: FileTransferData, type: string): string {
  try {
    return data.getData(type) || "";
  } catch {
    return "";
  }
}

/** Every path the transfer advertises, in source order and without duplicates. */
export function transferredPaths(data: FileTransferData | null | undefined): string[] {
  if (!data) return [];
  const paths: string[] = [];
  const seen = new Set<string>();
  const push = (path: string) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    paths.push(path);
  };
  for (const line of readFlavor(data, FILE_PATH_MIME).split("\n")) push(line.trim());
  for (const path of parseUriList(readFlavor(data, URI_LIST_MIME))) push(path);
  for (const path of parseGnomeCopiedFiles(readFlavor(data, GNOME_COPIED_FILES_MIME))) push(path);
  return paths;
}

/**
 * A file drag that the app does not accept must not reach the webview's default handling: WebKitGTK
 * would navigate away to the file. Capture-phase listeners prevent that without stopping the app's
 * own handlers, which still receive the event.
 */
export function installFileTransferNavigationGuard(target: Window): void {
  const guard = (event: DragEvent) => {
    if (event.defaultPrevented) return;
    if (!isFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
  };
  target.addEventListener("dragover", guard, true);
  target.addEventListener("drop", guard, true);
}

/** Names what a pasted path list would attach, so the confirmation is specific. */
export function pastedPathsConfirmationTitle(paths: readonly string[]): string {
  if (paths.length === 1) {
    const name = paths[0]!.split("/").filter(Boolean).at(-1) ?? paths[0]!;
    return `Attach "${name}" from the clipboard?`;
  }
  return `Attach ${paths.length} items from the clipboard?`;
}
