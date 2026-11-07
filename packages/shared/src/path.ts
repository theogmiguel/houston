const IS_WINDOWS_DRIVE_PATH_PATTERN = /^[a-zA-Z]:([/\\]|$)/;

export function isWindowsDrivePath(value: string): boolean {
  return IS_WINDOWS_DRIVE_PATH_PATTERN.test(value);
}

export function isUncPath(value: string): boolean {
  return value.startsWith("\\\\");
}

const IS_NETWORK_PATH_PATTERN = /^[\\/]{2}/;

/**
 * Windows treats `/` and `\` alike, so any two leading separators name a UNC
 * or device path. Touching one makes Windows sign in to that host with the
 * user's NTLM credentials, so agent-authored paths must not reach one.
 */
export function isNetworkPath(value: string): boolean {
  return IS_NETWORK_PATH_PATTERN.test(value);
}

export function isWindowsAbsolutePath(value: string): boolean {
  return isUncPath(value) || isWindowsDrivePath(value);
}

export function isExplicitRelativePath(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\")
  );
}

const IS_ROOT_PATH_PATTERN = /^[a-zA-Z]:[/\\]$/;

function isRootPath(value: string): boolean {
  // Bare C: means the current directory on C, not its root; require the drive separator.
  return value === "/" || value === "\\" || IS_ROOT_PATH_PATTERN.test(value);
}

const TRAILING_SLASHES = /\/+$/g;
const TRAILING_PATH_SEPARATORS = /[\\/]+$/g;
const TRIM_TRAILING_PATH_SEPARATORS_PATTERN = /^[a-zA-Z]:$/;

function trimTrailingPathSeparators(value: string): string {
  if (value.length === 0 || isRootPath(value)) {
    return value;
  }
  const trimmed = value.startsWith("/")
    ? value.replace(TRAILING_SLASHES, "")
    : value.replace(TRAILING_PATH_SEPARATORS, "");
  if (trimmed.length === 0) {
    return value;
  }
  return TRIM_TRAILING_PATH_SEPARATORS_PATTERN.test(trimmed) ? `${trimmed}\\` : trimmed;
}

export function normalizeProjectPathForDispatch(value: string): string {
  return trimTrailingPathSeparators(value.trim());
}

export function normalizeProjectPathForComparison(value: string): string {
  const normalized = normalizeProjectPathForDispatch(value);
  if (isWindowsDrivePath(normalized) || isUncPath(normalized)) {
    return normalized.replaceAll("/", "\\").toLowerCase();
  }
  return normalized;
}

// Windows refuses these as file names, with or without an extension.
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

const COMBINING_MARK = /[̀-ͯ]/g;
const NON_ALPHANUMERIC_RUN = /[^a-z0-9]+/g;
const LEADING_HYPHENS = /^-+/;
const TRAILING_HYPHENS = /-+$/;

export function newProjectFolderName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(COMBINING_MARK, "")
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_RUN, "-")
    .replace(LEADING_HYPHENS, "")
    .slice(0, 64)
    .replace(TRAILING_HYPHENS, "");
  if (slug.length === 0) return "project";
  return WINDOWS_RESERVED_NAME.test(slug) ? `${slug}-project` : slug;
}

const SLASH_PREFIXED_WINDOWS_DRIVE_PATTERN = /^\/[A-Za-z]:[\\/]/;

/** Browser URL parsers write `C:/foo` as `/C:/foo` for file URLs. */
export function stripSlashPrefixedWindowsDrive(path: string): string {
  return SLASH_PREFIXED_WINDOWS_DRIVE_PATTERN.test(path) ? path.slice(1) : path;
}

const TRAILING_SLASH_OR_BACKSLASH_RUN = /[/\\]+$/;

export function fileBasename(path: string): string {
  const trimmed = path.replace(TRAILING_SLASH_OR_BACKSLASH_RUN, "");
  if (trimmed.length === 0) return path;
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
}

const NORMALIZED_ROOT_PATTERN = /\/+$/;

export function workspaceRelativeFilePath(
  path: string,
  workspaceRoot: string | null | undefined,
): string | null {
  if (!workspaceRoot) return null;
  const normalizedPath = stripSlashPrefixedWindowsDrive(path.replaceAll("\\", "/"));
  const normalizedRoot = stripSlashPrefixedWindowsDrive(
    workspaceRoot.replaceAll("\\", "/"),
  ).replace(NORMALIZED_ROOT_PATTERN, "");
  const caseInsensitive = isWindowsAbsolutePath(stripSlashPrefixedWindowsDrive(workspaceRoot));
  const pathForCompare = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
  const rootForCompare = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  if (pathForCompare.replace(NORMALIZED_ROOT_PATTERN, "") === rootForCompare) return ".";
  if (!pathForCompare.startsWith(`${rootForCompare}/`)) return null;
  const relativePath = normalizedPath.slice(normalizedRoot.length + 1);
  // `/repo/../x` starts with the root but escapes it; the server rejects that as a workspace path.
  let depth = 0;
  for (const segment of relativePath.split("/")) {
    if (segment === "..") depth -= 1;
    else if (segment.length > 0 && segment !== ".") depth += 1;
    if (depth < 0) return null;
  }
  return relativePath;
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}

/** Home-relative host paths are expanded by the destination server. */
export function isHostPath(value: string): boolean {
  return isAbsolutePath(value) || value.startsWith("~/");
}

// Finder and Explorer copy a path ready for a shell: `'/a b'`, `/a\'s\ b`, or `"C:\a b"`.
const QUOTED_PATH_AT_END = /(?:'((?:[^']|'\\'')+)'|"([^"]+)")\s*$/;
const SHELL_ESCAPE = /\\([\s'"\\()[\]{}<>|&;$`!*?#~^=])/g;

const AFTER_FOLDER_PATTERN = /[/\\]$/;

/**
 * What a folder box holds after a change. A full path pasted into it replaces the box, even after
 * the text already there, because `~/'/a b'` would create that nested folder.
 */
export function resolvePastedPath(previous: string, next: string): string {
  const isTyping = next.startsWith(previous)
    ? next.length === previous.length + 1
    : previous.startsWith(next);
  if (isTyping) return next;

  const match = QUOTED_PATH_AT_END.exec(next);
  // Text before the quote that wasn't in the box is a search, not a folder to paste after.
  if (match && previous.startsWith(next.slice(0, match.index).trimEnd())) {
    const quoted = match[1]?.replaceAll("'\\''", "'") ?? match[2] ?? "";
    if (isHostPath(quoted)) return quoted;
  }

  // Without a trailing separator, `/a` then `/a/b` is a longer path, not one pasted after a folder.
  const afterFolder = AFTER_FOLDER_PATTERN.test(previous) && next.startsWith(previous);
  const path = afterFolder ? next.slice(previous.length) : next;
  if (!isHostPath(path)) return next;
  // `\` separates folders in Windows paths, so it only escapes in `/` and `~/` paths.
  return isWindowsAbsolutePath(path) ? path : path.replace(SHELL_ESCAPE, "$1");
}

export function resolveWorkspaceFilePath(path: string, workspaceRoot: string): string {
  if (isAbsolutePath(path) || path.startsWith("~/") || path.startsWith("~\\")) return path;
  const base = workspaceRoot.replace(TRAILING_SLASH_OR_BACKSLASH_RUN, "");
  return isWindowsAbsolutePath(workspaceRoot)
    ? `${base}\\${path.replaceAll("/", "\\")}`
    : `${base}/${path}`;
}
