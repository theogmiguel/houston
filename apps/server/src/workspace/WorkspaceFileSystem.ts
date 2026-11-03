// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import { ProjectWriteFileError } from "@houston-app/contracts";
import type {
  FilesystemEntryMetadata,
  FilesystemGetMetadataInput,
  FilesystemGetMetadataResult,
  ProjectCreateEntryInput,
  ProjectCreateEntryResult,
  ProjectDeleteEntryInput,
  ProjectDeleteEntryResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectRenameEntryInput,
  ProjectRenameEntryResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@houston-app/contracts";
import { expandHomePath } from "@houston-app/provider-core/server/pathExpansion";
import * as HostProcess from "@houston-app/shared/HostProcess";
import { isNetworkPath } from "@houston-app/shared/path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { makeIsServerInternalPath } from "../auth/serverInternalPaths.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import { fileHeaderMimeType } from "./fileHeaderMimeType.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

/** A stat-based content revision; a write names the revision its edit was based on. */
const fileRevision = (stat: NodeFS.Stats): string =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

// NTFS reaches .git through trailing dots/spaces, stream suffixes and GIT~1; compare uppercased names.
const isGitMetadataName = (segment: string) => {
  const name = (segment.split(":")[0] ?? "").replace(/[. ]+$/, "").toUpperCase();
  return name === ".GIT" || name === "GIT~1";
};

export class WorkspaceFileSystemOperationError extends Schema.TaggedError<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "realpath-workspace-root",
      "realpath-target",
      "open",
      "stat",
      "read",
      "close",
      "make-directory",
      "write-file",
      "create-entry",
      "rename",
      "delete",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

export class WorkspaceFilePathEscapeError extends Schema.TaggedError<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' resolves outside workspace root '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFileError extends Schema.TaggedError<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a file: ${this.resolvedPath}`;
  }
}

export class WorkspaceBinaryFileError extends Schema.TaggedError<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary and cannot be previewed as text.`;
  }
}

export class WorkspacePathExistsError extends Schema.TaggedError<WorkspacePathExistsError>()(
  "WorkspacePathExistsError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' already exists in '${this.workspaceRoot}': ${this.resolvedPath}. Expected a name that does not exist yet.`;
  }
}

export class WorkspacePathNotFoundError extends Schema.TaggedError<WorkspacePathNotFoundError>()(
  "WorkspacePathNotFoundError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' does not exist in '${this.workspaceRoot}': ${this.resolvedPath}. Expected an existing file, directory or symlink.`;
  }
}

export class WorkspacePathNotDirectoryError extends Schema.TaggedError<WorkspacePathNotDirectoryError>()(
  "WorkspacePathNotDirectoryError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a directory: ${this.resolvedPath}. Expected an existing folder to create the entry in.`;
  }
}

export class WorkspaceRootMutationError extends Schema.TaggedError<WorkspaceRootMutationError>()(
  "WorkspaceRootMutationError",
  { workspaceRoot: Schema.String, operation: Schema.Literals(["rename", "delete"]) },
) {
  override get message(): string {
    return `Refusing to ${this.operation} the project root '${this.workspaceRoot}'. Expected a path inside it.`;
  }
}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspaceBinaryFileError,
  WorkspacePathExistsError,
  WorkspacePathNotFoundError,
  WorkspacePathNotDirectoryError,
  WorkspaceRootMutationError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    readonly getMetadata: (
      input: FilesystemGetMetadataInput,
    ) => Effect.Effect<FilesystemGetMetadataResult>;

    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /** Writes inside a known workspace only. */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      | ProjectWriteFileError
      | WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
      | KnownWorkspaces.UnknownWorkspaceError
    >;
    readonly createEntry: (
      input: ProjectCreateEntryInput,
    ) => Effect.Effect<
      ProjectCreateEntryResult,
      | WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
      | KnownWorkspaces.UnknownWorkspaceError
    >;
    readonly renameEntry: (
      input: ProjectRenameEntryInput,
    ) => Effect.Effect<
      ProjectRenameEntryResult,
      | WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
      | KnownWorkspaces.UnknownWorkspaceError
    >;
    readonly deleteEntry: (
      input: ProjectDeleteEntryInput,
    ) => Effect.Effect<
      ProjectDeleteEntryResult,
      | WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
      | KnownWorkspaces.UnknownWorkspaceError
    >;
  }
>()("@houston-app/cli/workspace/WorkspaceFileSystem") {}

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const isServerInternalPath = yield* makeIsServerInternalPath;

  const metadataForPath = Effect.fnUntraced(function* (requestedPath: string) {
    const expandedPath = expandHomePath(requestedPath, yield* HostProcess.HomeDirectory);
    // Chips ask as soon as an agent's message renders, and touching a network
    // path makes Windows sign in to its host with the user's NTLM credentials.
    if (!path.isAbsolute(expandedPath) || isNetworkPath(expandedPath)) return null;
    const stat = yield* fileSystem.stat(expandedPath).pipe(Effect.option);
    if (stat._tag === "None") return null;
    if (stat.value.type === "Directory") return { kind: "directory" } as const;
    if (stat.value.type !== "File") return { kind: "other" } as const;
    let mimeType: string | undefined;
    if (path.extname(expandedPath) === "" && stat.value.size > 0) {
      mimeType = yield* Effect.tryPromise({
        try: async () => {
          const handle = await NodeFSP.open(
            expandedPath,
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK,
          );
          try {
            if (!(await handle.stat()).isFile()) return undefined;
            const buffer = Buffer.alloc(512);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            return fileHeaderMimeType(buffer.subarray(0, bytesRead));
          } finally {
            await handle.close();
          }
        },
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined));
    }
    return {
      kind: "file",
      byteLength: Number(stat.value.size),
      ...(mimeType === undefined ? {} : { mimeType }),
    } satisfies FilesystemEntryMetadata;
  });

  const getMetadata: WorkspaceFileSystem["Service"]["getMetadata"] = Effect.fn(
    "WorkspaceFileSystem.getMetadata",
  )(function* (input) {
    const paths = [...new Set(input.paths)];
    const entries = yield* Effect.forEach(paths, metadataForPath, { concurrency: 8 });
    const byPath = new Map(paths.map((value, index) => [value, entries[index] ?? null]));
    return { entries: input.paths.map((value) => byPath.get(value) ?? null) };
  });

  /** Both paths must already be real paths. */
  const isInsideRealRoot = (realWorkspaceRoot: string, realPath: string) => {
    const relative = path.relative(realWorkspaceRoot, realPath);
    return !(
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    );
  };

  // Reject Git folders, including renamed bare repos whose config/hooks can execute; paths must be normalized.
  // Stop at linked worktrees' .git files since worktrees can sit inside bare repos.
  const isInGitFolder = async (absolutePath: string) => {
    if (absolutePath.split(path.sep).some(isGitMetadataName)) return true;
    for (let folder = path.dirname(absolutePath); ; folder = path.dirname(folder)) {
      const [head, commondir, objects, refs, dotGit] = await Promise.all(
        ["HEAD", "commondir", "objects", "refs", ".git"].map((name) =>
          NodeFSP.lstat(path.join(folder, name)).catch((error: NodeJS.ErrnoException) => {
            // Any other failure leaves the folder unknown, so the write is refused.
            if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
            throw error;
          }),
        ),
      );
      // Git recognizes HEAD with commondir or objects/refs as a repository.
      if (head && (commondir || (objects && refs))) return true;
      if (dotGit?.isFile() || path.dirname(folder) === folder) return false;
    }
  };

  /**
   * Workspace-relative paths must stay inside the root, symlinks included. An
   * absolute or `~/` path reads a host file in place, such as a report an agent
   * wrote to a temp directory; it gets no root check. A network path does, since
   * Windows signs in to its host with the user's NTLM credentials.
   */
  const resolveReadTarget = Effect.fn("WorkspaceFileSystem.resolveReadTarget")(function* (
    input: ProjectReadFileInput,
  ) {
    const requestedPath = input.relativePath.trim();
    const hostPath = requestedPath.startsWith("~/")
      ? expandHomePath(requestedPath, yield* HostProcess.HomeDirectory)
      : requestedPath;
    if (
      isNetworkPath(hostPath) &&
      !KnownWorkspaces.isWithinRoot(path, path.resolve(hostPath), path.resolve(input.cwd))
    ) {
      return yield* new WorkspacePaths.WorkspacePathOutsideRootError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
    }
    if (path.isAbsolute(hostPath)) {
      // Native realpath hands Windows a `\\?\` path as written, `..` included,
      // so a network path must be the resolved one the check above approved.
      // Others keep POSIX `link/..` semantics, which resolving first would change.
      const absolutePath = isNetworkPath(hostPath) ? path.resolve(hostPath) : hostPath;
      const realTargetPath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(absolutePath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: absolutePath,
            operationPath: absolutePath,
            operation: "realpath-target",
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) =>
            input.allowMissing === true && (error.cause as NodeJS.ErrnoException).code === "ENOENT",
          () => Effect.succeed(null),
        ),
      );
      return { relativePath: requestedPath, realTargetPath };
    }

    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(path.resolve(input.cwd)),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });
    const resolved = yield* Effect.tryPromise({
      try: async () => {
        let candidate = target.absolutePath;
        for (;;) {
          try {
            return {
              realTargetPath: path.join(
                await NodeFSP.realpath(candidate),
                path.relative(candidate, target.absolutePath),
              ),
              exists: candidate === target.absolutePath,
            };
          } catch (error) {
            if (!input.allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
            // Like writes, missing reads must check the nearest existing ancestor.
            // An existing entry that cannot resolve is a dangling link, not absence.
            const exists = await NodeFSP.lstat(candidate).then(
              () => true,
              (cause: NodeJS.ErrnoException) => {
                if (cause.code !== "ENOENT") throw cause;
                return false;
              },
            );
            if (exists || path.dirname(candidate) === candidate) throw error;
            candidate = path.dirname(candidate);
          }
        }
      },
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    if (!isInsideRealRoot(realWorkspaceRoot, resolved.realTargetPath)) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: resolved.realTargetPath,
      });
    }
    return {
      relativePath: target.relativePath,
      realTargetPath: resolved.exists ? resolved.realTargetPath : null,
    };
  });

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* resolveReadTarget(input);
    const absentResult = {
      relativePath: target.relativePath,
      contents: "",
      byteLength: 0,
      truncated: false,
      exists: false,
    };
    const realTargetPath = target.realTargetPath;
    if (realTargetPath === null) return absentResult;
    if (yield* isServerInternalPath(realTargetPath)) {
      return yield* new WorkspacePaths.WorkspacePathOutsideRootError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
    }

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        // Non-blocking opens prevent FIFO hangs before stat rejects them; Windows lacks the flag.
        try: () =>
          NodeFSP.open(
            realTargetPath,
            NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0),
          ),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: realTargetPath,
            operation: "open",
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) =>
            input.allowMissing === true && (error.cause as NodeJS.ErrnoException).code === "ENOENT",
          () => Effect.succeed(null),
        ),
      ),
      (handle) =>
        Effect.gen(function* () {
          if (handle === null) return absentResult;
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "stat",
                cause,
              }),
          });
          if (!stat.isFile()) {
            return yield* new WorkspacePathNotFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const bytesToRead = Math.min(stat.size, PROJECT_READ_FILE_MAX_BYTES);
          const buffer = Buffer.alloc(bytesToRead);
          let offset = 0;
          while (offset < bytesToRead) {
            const { bytesRead } = yield* Effect.tryPromise({
              try: () => handle.read(buffer, offset, bytesToRead - offset, offset),
              catch: (cause) =>
                new WorkspaceFileSystemOperationError({
                  workspaceRoot: input.cwd,
                  relativePath: input.relativePath,
                  resolvedPath: realTargetPath,
                  operationPath: realTargetPath,
                  operation: "read",
                  cause,
                }),
            });
            if (bytesRead <= 0) break;
            offset += bytesRead;
          }
          const fileBytes = buffer.subarray(0, offset);
          if (fileBytes.includes(0)) {
            return yield* new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const truncated = stat.size > PROJECT_READ_FILE_MAX_BYTES;
          return {
            relativePath: target.relativePath,
            // Streaming decode drops a character the byte limit split, instead of ending in U+FFFD.
            contents: new TextDecoder("utf-8").decode(fileBytes, { stream: truncated }),
            byteLength: stat.size,
            truncated,
            revision: fileRevision(stat),
          };
        }),
      (handle) =>
        handle === null
          ? Effect.void
          : Effect.tryPromise({
              try: () => handle.close(),
              catch: (cause) =>
                new WorkspaceFileSystemOperationError({
                  workspaceRoot: input.cwd,
                  relativePath: input.relativePath,
                  resolvedPath: realTargetPath,
                  operationPath: realTargetPath,
                  operation: "close",
                  cause,
                }),
            }),
    );
  });

  // Resolve existing ancestors and reject dangling links so creation cannot follow symlinks outside root.
  const resolveWriteTarget = Effect.fn("WorkspaceFileSystem.resolveWriteTarget")(function* (input: {
    readonly cwd: string;
    readonly relativePath: string;
  }) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const realWorkspaceRoot = yield* Effect.tryPromise({
      // Resolve `..` in cwd the way the relative path was resolved, before following links.
      try: () => NodeFSP.realpath(path.resolve(input.cwd)),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });

    // Split the host path, not the display relativePath: on POSIX `\` is a file name character.
    const segments = path.relative(input.cwd, target.absolutePath).split(path.sep);
    const realTargetPath = yield* Effect.tryPromise({
      try: async () => {
        for (let depth = segments.length; depth > 0; depth--) {
          const candidate = path.join(realWorkspaceRoot, ...segments.slice(0, depth));
          try {
            return path.join(await NodeFSP.realpath(candidate), ...segments.slice(depth));
          } catch (error) {
            // Only a missing entry is skipped; one that exists but cannot resolve is a dangling link.
            const exists = await NodeFSP.lstat(candidate).then(
              () => true,
              () => false,
            );
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" || exists) throw error;
          }
        }
        return path.join(realWorkspaceRoot, ...segments);
      },
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    // The path as named is checked too: a `.git/config` symlink resolves away the `.git`.
    const namedTargetPath = path.join(realWorkspaceRoot, ...segments);
    const inGitFolder = Effect.fn("WorkspaceFileSystem.inGitFolder")((checkedPath: string) =>
      Effect.tryPromise({
        try: () => isInGitFolder(checkedPath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: checkedPath,
            operation: "stat",
            cause,
          }),
      }),
    );
    if (
      !isInsideRealRoot(realWorkspaceRoot, realTargetPath) ||
      (yield* inGitFolder(realTargetPath)) ||
      (yield* inGitFolder(namedTargetPath))
    ) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    return { relativePath: target.relativePath, realTargetPath };
  });

  // Rename and delete act on the entry itself, so a symlink is moved or removed rather
  // than its target; only the parent directory is resolved to keep the entry inside root.
  const resolveEntryTarget = Effect.fn("WorkspaceFileSystem.resolveEntryTarget")(function* (input: {
    readonly cwd: string;
    readonly relativePath: string;
  }) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(path.resolve(input.cwd)),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });
    const segments = path.relative(input.cwd, target.absolutePath).split(path.sep);
    const name = segments.pop();
    if (name === undefined || name === "")
      return yield* new WorkspaceRootMutationError({
        workspaceRoot: input.cwd,
        operation: "delete",
      });
    const parentPath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(path.join(realWorkspaceRoot, ...segments)),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: path.join(realWorkspaceRoot, ...segments),
          operation: "realpath-target",
          cause,
        }),
    });
    const realEntryPath = path.join(parentPath, name);
    if (
      !isInsideRealRoot(realWorkspaceRoot, realEntryPath) ||
      (yield* Effect.tryPromise({
        try: () => isInGitFolder(realEntryPath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realEntryPath,
            operationPath: realEntryPath,
            operation: "stat",
            cause,
          }),
      }))
    )
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realEntryPath,
      });
    return { relativePath: target.relativePath, realEntryPath };
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    yield* knownWorkspaces.assertContains(input.cwd);
    const target = yield* resolveWriteTarget(input);
    const realTargetPath = target.realTargetPath;
    const replacesFile = yield* fileSystem
      .exists(realTargetPath)
      .pipe(Effect.orElseSucceed(() => false));

    if (input.expectedRevision !== undefined) {
      const actualRevision = replacesFile
        ? yield* Effect.tryPromise({
            try: async () => fileRevision(await NodeFSP.stat(realTargetPath)),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "stat",
                cause,
              }),
          })
        : "";
      if (actualRevision !== input.expectedRevision) {
        return yield* new ProjectWriteFileError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          failure: "stale_revision",
          resolvedPath: realTargetPath,
          expectedRevision: input.expectedRevision,
          ...(replacesFile ? { actualRevision } : {}),
        });
      }
    }

    yield* fileSystem.makeDirectory(path.dirname(realTargetPath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: path.dirname(realTargetPath),
            operation: "make-directory",
            cause,
          }),
      ),
    );
    yield* Effect.tryPromise({
      // A symlink swapped in after the check is not followed. Windows lacks O_NOFOLLOW.
      try: () =>
        NodeFSP.writeFile(realTargetPath, input.contents, {
          flag:
            NodeFS.constants.O_WRONLY |
            NodeFS.constants.O_CREAT |
            NodeFS.constants.O_TRUNC |
            (NodeFS.constants.O_NOFOLLOW ?? 0),
        }),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: realTargetPath,
          operationPath: realTargetPath,
          operation: "write-file",
          cause,
        }),
    });
    // Editor autosave overwrites existing files, which leaves the indexed paths unchanged, and
    // fff's watcher applies the new contents on its own. A forced rescan re-walks the whole
    // workspace, and the save would wait for it.
    if (!replacesFile) {
      yield* workspaceEntries.refresh(input.cwd);
    }
    const writtenRevision = yield* Effect.tryPromise({
      try: async () => fileRevision(await NodeFSP.stat(realTargetPath)),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: realTargetPath,
          operationPath: realTargetPath,
          operation: "stat",
          cause,
        }),
    });
    return { relativePath: target.relativePath, revision: writtenRevision };
  });

  const mutationOperationError = (input: {
    readonly cwd: string;
    readonly relativePath: string;
    readonly resolvedPath: string;
    readonly operationPath: string;
    readonly operation: "create-entry" | "rename" | "delete";
    readonly cause: unknown;
  }) => new WorkspaceFileSystemOperationError({ workspaceRoot: input.cwd, ...input });

  const entryStat = (input: {
    readonly cwd: string;
    readonly relativePath: string;
    readonly resolvedPath: string;
    readonly operation: "rename" | "delete";
  }) =>
    Effect.tryPromise({
      try: () => NodeFSP.lstat(input.resolvedPath),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: input.resolvedPath,
          operationPath: input.resolvedPath,
          operation: "stat",
          cause,
        }),
    }).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
        () => Effect.succeedNone,
      ),
    );

  const createEntry: WorkspaceFileSystem["Service"]["createEntry"] = Effect.fn(
    "WorkspaceFileSystem.createEntry",
  )(function* (input) {
    yield* knownWorkspaces.assertContains(input.cwd);
    const target = yield* resolveWriteTarget(input);
    if (target.relativePath === "." || target.relativePath === "")
      return yield* new WorkspacePathExistsError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: target.realTargetPath,
      });
    if (yield* fileSystem.exists(target.realTargetPath).pipe(Effect.orElseSucceed(() => false)))
      return yield* new WorkspacePathExistsError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: target.realTargetPath,
      });
    const parentPath = path.dirname(target.realTargetPath);
    const parent = yield* fileSystem.stat(parentPath).pipe(Effect.orElseSucceed(() => null));
    if (parent === null)
      return yield* new WorkspacePathNotFoundError({
        workspaceRoot: input.cwd,
        relativePath: path.relative(input.cwd, parentPath),
        resolvedPath: parentPath,
      });
    if (parent.type !== "Directory")
      return yield* new WorkspacePathNotDirectoryError({
        workspaceRoot: input.cwd,
        relativePath: path.relative(input.cwd, parentPath),
        resolvedPath: parentPath,
      });

    yield* Effect.tryPromise({
      try: () =>
        input.kind === "directory"
          ? NodeFSP.mkdir(target.realTargetPath)
          : NodeFSP.open(
              target.realTargetPath,
              NodeFS.constants.O_WRONLY |
                NodeFS.constants.O_CREAT |
                NodeFS.constants.O_EXCL |
                (NodeFS.constants.O_NOFOLLOW ?? 0),
            ).then((handle) => handle.close()),
      catch: (cause) =>
        mutationOperationError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.realTargetPath,
          operationPath: target.realTargetPath,
          operation: "create-entry",
          cause,
        }),
    });
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath, kind: input.kind };
  });

  const renameEntry: WorkspaceFileSystem["Service"]["renameEntry"] = Effect.fn(
    "WorkspaceFileSystem.renameEntry",
  )(function* (input) {
    yield* knownWorkspaces.assertContains(input.cwd);
    if (input.fromPath.trim() === ".")
      return yield* new WorkspaceRootMutationError({
        workspaceRoot: input.cwd,
        operation: "rename",
      });
    const source = yield* resolveEntryTarget({
      cwd: input.cwd,
      relativePath: input.fromPath,
    });
    const sourceStat = yield* entryStat({
      cwd: input.cwd,
      relativePath: input.fromPath,
      resolvedPath: source.realEntryPath,
      operation: "rename",
    });
    if (Option.isNone(sourceStat))
      return yield* new WorkspacePathNotFoundError({
        workspaceRoot: input.cwd,
        relativePath: input.fromPath,
        resolvedPath: source.realEntryPath,
      });
    const destination = yield* resolveWriteTarget({
      cwd: input.cwd,
      relativePath: input.toPath,
    });
    if (
      yield* fileSystem.exists(destination.realTargetPath).pipe(Effect.orElseSucceed(() => false))
    )
      return yield* new WorkspacePathExistsError({
        workspaceRoot: input.cwd,
        relativePath: input.toPath,
        resolvedPath: destination.realTargetPath,
      });
    const parent = yield* fileSystem
      .stat(path.dirname(destination.realTargetPath))
      .pipe(Effect.orElseSucceed(() => null));
    if (parent === null)
      return yield* new WorkspacePathNotFoundError({
        workspaceRoot: input.cwd,
        relativePath: path.relative(input.cwd, path.dirname(destination.realTargetPath)),
        resolvedPath: path.dirname(destination.realTargetPath),
      });
    if (parent.type !== "Directory")
      return yield* new WorkspacePathNotDirectoryError({
        workspaceRoot: input.cwd,
        relativePath: path.relative(input.cwd, path.dirname(destination.realTargetPath)),
        resolvedPath: path.dirname(destination.realTargetPath),
      });

    yield* Effect.tryPromise({
      try: () => NodeFSP.rename(source.realEntryPath, destination.realTargetPath),
      catch: (cause) =>
        mutationOperationError({
          cwd: input.cwd,
          relativePath: input.fromPath,
          resolvedPath: destination.realTargetPath,
          operationPath: source.realEntryPath,
          operation: "rename",
          cause,
        }),
    });
    yield* workspaceEntries.refresh(input.cwd);
    return { fromPath: source.relativePath, toPath: destination.relativePath };
  });

  const deleteEntry: WorkspaceFileSystem["Service"]["deleteEntry"] = Effect.fn(
    "WorkspaceFileSystem.deleteEntry",
  )(function* (input) {
    yield* knownWorkspaces.assertContains(input.cwd);
    if (input.relativePath.trim() === ".")
      return yield* new WorkspaceRootMutationError({
        workspaceRoot: input.cwd,
        operation: "delete",
      });
    const target = yield* resolveEntryTarget(input);
    const targetStat = yield* entryStat({
      cwd: input.cwd,
      relativePath: input.relativePath,
      resolvedPath: target.realEntryPath,
      operation: "delete",
    });
    if (Option.isNone(targetStat))
      return yield* new WorkspacePathNotFoundError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: target.realEntryPath,
      });
    yield* Effect.tryPromise({
      try: () => NodeFSP.rm(target.realEntryPath, { recursive: true, force: false }),
      catch: (cause) =>
        mutationOperationError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.realEntryPath,
          operationPath: target.realEntryPath,
          operation: "delete",
          cause,
        }),
    });
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  return WorkspaceFileSystem.of({
    getMetadata,
    readFile,
    writeFile,
    createEntry,
    renameEntry,
    deleteEntry,
  });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
