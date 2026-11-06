import { pipe } from "effect/Function";
import {
  fileBasename,
  stripSlashPrefixedWindowsDrive,
  isWindowsAbsolutePath,
} from "@houston-app/shared/path";
import { formatFilePathPosition, splitFilePathPosition } from "@houston-app/shared/fileLinks";

const TRAILING_PATH_SEPARATORS = /[\\/]+$/;
const STRIP_RELATIVE_PREFIXES_PATTERN = /^\.\/+/;
const LEADING_SLASHES = /^\/+/;

function normalizePathSeparators(path: string): string {
  return path.replaceAll("\\", "/");
}

function trimTrailingPathSeparators(path: string): string {
  return path.replace(TRAILING_PATH_SEPARATORS, "");
}

function stripRelativePrefixes(path: string): string {
  return path.replace(STRIP_RELATIVE_PREFIXES_PATTERN, "").replace(LEADING_SLASHES, "");
}

export function formatWorkspaceRelativePath(
  pathWithPosition: string,
  workspaceRoot: string | undefined,
): string {
  const position = splitFilePathPosition(pathWithPosition);
  const normalizedPath = stripSlashPrefixedWindowsDrive(normalizePathSeparators(position.path));

  let displayPath = normalizedPath;
  if (workspaceRoot) {
    const normalizedWorkspaceRoot = pipe(
      trimTrailingPathSeparators(workspaceRoot),
      normalizePathSeparators,
      stripSlashPrefixedWindowsDrive,
    );
    const workspaceLabel = fileBasename(normalizedWorkspaceRoot);
    const caseInsensitive = isWindowsAbsolutePath(stripSlashPrefixedWindowsDrive(workspaceRoot));
    const pathForCompare = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
    const workspaceForCompare = caseInsensitive
      ? normalizedWorkspaceRoot.toLowerCase()
      : normalizedWorkspaceRoot;
    const workspaceWithSeparator = `${workspaceForCompare}/`;
    const workspaceLabelWithSeparator = `${caseInsensitive ? workspaceLabel.toLowerCase() : workspaceLabel}/`;

    if (pathForCompare === workspaceForCompare) {
      displayPath = workspaceLabel;
    } else if (pathForCompare.startsWith(workspaceWithSeparator)) {
      const relativeSuffix = normalizedPath.slice(normalizedWorkspaceRoot.length + 1);
      displayPath = `${workspaceLabel}/${relativeSuffix}`;
    } else if (!normalizedPath.startsWith("/")) {
      const relativePath = stripRelativePrefixes(normalizedPath);
      displayPath = pathForCompare.startsWith(workspaceLabelWithSeparator)
        ? normalizedPath
        : `${workspaceLabel}/${relativePath}`;
    }
  }

  return formatFilePathPosition({ ...position, path: displayPath });
}
