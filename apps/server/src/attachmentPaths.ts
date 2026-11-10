// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

const LEADING_PATH_SEPARATORS = /^[/\\]+/;
const BACKSLASH = /\\/g;

export function normalizeAttachmentRelativePath(rawRelativePath: string): string | null {
  const normalized = NodePath.normalize(rawRelativePath).replace(LEADING_PATH_SEPARATORS, "");
  if (normalized.length === 0 || normalized.startsWith("..") || normalized.includes("\0")) {
    return null;
  }
  return normalized.replace(BACKSLASH, "/");
}

export function resolveAttachmentRelativePath(input: {
  readonly attachmentsDir: string;
  readonly relativePath: string;
}): string | null {
  const normalizedRelativePath = normalizeAttachmentRelativePath(input.relativePath);
  if (!normalizedRelativePath) {
    return null;
  }

  const attachmentsRoot = NodePath.resolve(input.attachmentsDir);
  const filePath = NodePath.resolve(NodePath.join(attachmentsRoot, normalizedRelativePath));
  if (!filePath.startsWith(`${attachmentsRoot}${NodePath.sep}`)) {
    return null;
  }
  return filePath;
}
