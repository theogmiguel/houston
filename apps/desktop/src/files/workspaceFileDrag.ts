// @effect-diagnostics nodeBuiltinImport:off -- Native drags resolve real paths before Electron receives a file.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export type WorkspaceFileDragRule =
  | "workspace-root-too-broad"
  | "workspace-root-missing"
  | "outside-workspace"
  | "missing"
  | "not-a-file";

export class WorkspaceFileDragError extends Error {
  readonly requestedPath: string;
  readonly rule: WorkspaceFileDragRule;

  constructor(requestedPath: string, rule: WorkspaceFileDragRule, message: string) {
    super(message);
    this.name = "WorkspaceFileDragError";
    this.requestedPath = requestedPath;
    this.rule = rule;
  }
}

function isInside(root: string, target: string): boolean {
  const relative = NodePath.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${NodePath.sep}`) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  );
}

export async function resolveWorkspaceFileForDrag(input: {
  readonly path: string;
  readonly workspaceRoot: string;
}): Promise<string> {
  const requestedPath = input.path;
  const workspaceRoot = NodePath.resolve(input.workspaceRoot);
  // The renderer names the root, so a root that spans the whole filesystem would make containment meaningless.
  if (NodePath.parse(workspaceRoot).root === workspaceRoot) {
    throw new WorkspaceFileDragError(
      input.path,
      "workspace-root-too-broad",
      `Cannot drag "${input.path}": the workspace root "${input.workspaceRoot}" is a filesystem root.`,
    );
  }
  const candidate = NodePath.isAbsolute(requestedPath)
    ? NodePath.resolve(requestedPath)
    : NodePath.resolve(workspaceRoot, requestedPath);

  if (!isInside(workspaceRoot, candidate)) {
    throw new WorkspaceFileDragError(
      requestedPath,
      "outside-workspace",
      `Cannot drag "${requestedPath}": it is outside the workspace root "${input.workspaceRoot}".`,
    );
  }

  const realRoot = await NodeFSP.realpath(workspaceRoot).catch(() => null);
  if (realRoot === null) {
    throw new WorkspaceFileDragError(
      requestedPath,
      "workspace-root-missing",
      `Cannot drag "${requestedPath}": the workspace root "${input.workspaceRoot}" does not exist.`,
    );
  }

  const realCandidate = await NodeFSP.realpath(candidate).catch(() => null);
  if (realCandidate === null || !isInside(realRoot, realCandidate)) {
    throw new WorkspaceFileDragError(
      requestedPath,
      realCandidate === null ? "missing" : "outside-workspace",
      realCandidate === null
        ? `Cannot drag "${requestedPath}": it does not exist inside the workspace root "${input.workspaceRoot}".`
        : `Cannot drag "${requestedPath}": it is outside the workspace root "${input.workspaceRoot}".`,
    );
  }

  const stats = await NodeFSP.stat(realCandidate).catch(() => null);
  if (stats === null) {
    throw new WorkspaceFileDragError(
      requestedPath,
      "missing",
      `Cannot drag "${requestedPath}": it does not exist inside the workspace root "${input.workspaceRoot}".`,
    );
  }
  if (!stats.isFile()) {
    throw new WorkspaceFileDragError(
      requestedPath,
      "not-a-file",
      `Cannot drag "${requestedPath}": it is not a regular file.`,
    );
  }

  return realCandidate;
}
