// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's symlink has no type argument and its stat loses NTFS file ids past 2^53.
import * as NodeFSP from "node:fs/promises";

import { ProviderDriverKind, type CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

export interface CodexHomeLayout {
  readonly mode: "direct" | "authOverlay";
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string | undefined;
  readonly continuationKey: string;
}

const KNOWN_SHARED_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "sqlite",
  "shell_snapshots",
  "worktrees",
  "skills",
  "plugins",
  "cache",
  "logs",
  "mcp-oauth-locks",
  "thread-writer-locks",
] as const;

// auth.lock guards the shadow home's private auth.json.
const PRIVATE_ENTRY_NAMES = new Set(["auth.json", "auth.lock", "models_cache.json"]);
// The entries the win32 fallback hard-linked; see readHardLinkRecord.
const HARD_LINK_RECORD_NAME = ".houston-shadow-links.json";
// Finder maintains metadata separately for each directory, including shadow homes.
const SHADOW_LOCAL_ENTRY_NAMES = new Set([
  "log",
  "memories",
  "tmp",
  ".DS_Store",
  HARD_LINK_RECORD_NAME,
]);
// Shadow homes may create local runtime locks first; replace them with shared links because they guard shared state.
const REPLACEABLE_SHARED_RUNTIME_ENTRIES = new Set([
  "mcp-oauth-locks",
  "thread-writer-locks",
  ".sqlite-maintenance.lock",
]);

function resolveHomePath(path: Path.Path, home: string, value: string | undefined): string {
  const expanded =
    value && value.trim().length > 0 ? expandHomePath(value, home) : path.join(home, ".codex");
  return path.resolve(expanded);
}

export const resolveCodexHomeLayout = Effect.fn("resolveCodexHomeLayout")(function* (
  config: CodexSettings,
): Effect.fn.Return<CodexHomeLayout, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const sharedHomePath = resolveHomePath(path, home, config.homePath);
  const shadowHomePath = config.shadowHomePath.trim();
  if (shadowHomePath.length === 0) {
    return {
      mode: "direct",
      sharedHomePath,
      effectiveHomePath: config.homePath.trim().length > 0 ? sharedHomePath : undefined,
      continuationKey: `codex:home:${sharedHomePath}`,
    };
  }

  const effectiveHomePath = path.resolve(expandHomePath(shadowHomePath, home));
  return {
    mode: "authOverlay",
    sharedHomePath,
    effectiveHomePath,
    continuationKey: `codex:home:${sharedHomePath}`,
  };
});

const CodexShadowHomeContext = {
  sharedHomePath: Schema.String,
  effectiveHomePath: Schema.String,
};

export class CodexShadowHomeFileSystemError extends Schema.TaggedError<CodexShadowHomeFileSystemError>()(
  "CodexShadowHomeFileSystemError",
  {
    ...CodexShadowHomeContext,
    operation: Schema.Literals([
      "readLink",
      "makeDirectory",
      "readDirectory",
      "remove",
      "symlink",
      "stat",
      "junction",
      "writeFile",
    ]),
    path: Schema.String,
    targetPath: Schema.optional(Schema.String),
    entryName: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.targetPath === undefined ? "" : ` to '${this.targetPath}'`;
    return `Codex shadow home filesystem operation '${this.operation}' failed for '${this.path}'${target}.`;
  }
}

export class CodexShadowHomePathConflictError extends Schema.TaggedError<CodexShadowHomePathConflictError>()(
  "CodexShadowHomePathConflictError",
  CodexShadowHomeContext,
) {
  override get message(): string {
    return `Codex shadow home path '${this.effectiveHomePath}' must be different from the shared home path '${this.sharedHomePath}'.`;
  }
}

export class CodexShadowHomeEntryConflictError extends Schema.TaggedError<CodexShadowHomeEntryConflictError>()(
  "CodexShadowHomeEntryConflictError",
  {
    ...CodexShadowHomeContext,
    entryName: Schema.String,
    linkPath: Schema.String,
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot create Codex shadow home entry '${this.entryName}' because '${this.linkPath}' already exists and is not a symlink.`;
  }
}

export class CodexShadowHomePrivateEntrySymlinkError extends Schema.TaggedError<CodexShadowHomePrivateEntrySymlinkError>()(
  "CodexShadowHomePrivateEntrySymlinkError",
  {
    ...CodexShadowHomeContext,
    entryName: Schema.String,
    path: Schema.String,
  },
) {
  override get message(): string {
    return `Codex shadow home private entry '${this.entryName}' at '${this.path}' must be a real file, not a symlink.`;
  }
}

export class CodexShadowHomeHardLinkError extends Schema.TaggedError<CodexShadowHomeHardLinkError>()(
  "CodexShadowHomeHardLinkError",
  {
    ...CodexShadowHomeContext,
    entryName: Schema.String,
    linkPath: Schema.String,
    targetPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Cannot share Codex shadow home file '${this.entryName}': Windows refused a symlink at '${this.linkPath}' and a hard link to '${this.targetPath}' failed. Enable Developer Mode for symlink privilege, or keep the shadow home on the same volume as the shared home.`;
  }
}

export const CodexShadowHomeError = Schema.Union([
  CodexShadowHomeFileSystemError,
  CodexShadowHomeHardLinkError,
  CodexShadowHomePathConflictError,
  CodexShadowHomeEntryConflictError,
  CodexShadowHomePrivateEntrySymlinkError,
]);
export type CodexShadowHomeError = typeof CodexShadowHomeError.Type;

type LinkState =
  | {
      readonly _tag: "Missing";
    }
  | {
      readonly _tag: "NotSymlink";
    }
  | {
      readonly _tag: "Symlink";
      readonly target: string;
    };

function hasErrorCode(error: PlatformError.PlatformError, code: string): boolean {
  const cause = error.reason.cause;
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
}

// A hard link made by the win32 fallback reads as NotSymlink; it is linked when it is the same file.
const isSameFile = (left: string, right: string) =>
  Effect.promise(() =>
    Promise.all([NodeFSP.stat(left, { bigint: true }), NodeFSP.stat(right, { bigint: true })]).then(
      ([a, b]) => a.dev === b.dev && a.ino === b.ino,
      () => false,
    ),
  );

function isNotSymlinkError(error: PlatformError.PlatformError): boolean {
  const cause = error.reason.cause;
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EINVAL"
  );
}

const readLinkState = Effect.fn("CodexHomeLayout.readLinkState")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
  readonly linkPath: string;
}): Effect.fn.Return<LinkState, CodexShadowHomeError> {
  return yield* input.fileSystem.readLink(input.linkPath).pipe(
    Effect.map((target): LinkState => ({ _tag: "Symlink", target })),
    Effect.catchTags({
      PlatformError: (cause) => {
        if (cause.reason._tag === "NotFound") {
          return Effect.succeed<LinkState>({ _tag: "Missing" });
        }
        if (isNotSymlinkError(cause)) {
          return Effect.succeed<LinkState>({ _tag: "NotSymlink" });
        }
        return new CodexShadowHomeFileSystemError({
          sharedHomePath: input.sharedHomePath,
          effectiveHomePath: input.effectiveHomePath,
          operation: "readLink",
          path: input.linkPath,
          entryName: input.entryName,
          cause,
        });
      },
    }),
  );
});

const removePrivateSymlink = Effect.fn("CodexHomeLayout.removePrivateSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const privatePath = path.join(input.effectiveHomePath, input.entryName);
  const state = yield* readLinkState({
    ...input,
    linkPath: privatePath,
  });
  if (state._tag === "Symlink") {
    yield* input.fileSystem.remove(privatePath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: privatePath,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
  }
});

// Windows without Developer Mode refuses symlinks with EPERM. A junction needs no privilege but
// targets only a directory, so a shared file becomes a hard link, which must stay on one volume.
const createWindowsFallbackLink = Effect.fn("CodexHomeLayout.createWindowsFallbackLink")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly sharedHomePath: string;
    readonly effectiveHomePath: string;
    readonly entryName: string;
    readonly target: string;
    readonly link: string;
    readonly hardLinked: Set<string>;
  }): Effect.fn.Return<void, CodexShadowHomeError> {
    const context = {
      sharedHomePath: input.sharedHomePath,
      effectiveHomePath: input.effectiveHomePath,
      entryName: input.entryName,
    };
    const info = yield* input.fileSystem.stat(input.target).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            ...context,
            operation: "stat",
            path: input.target,
            cause,
          }),
      }),
    );
    if (info.type === "Directory") {
      return yield* Effect.tryPromise({
        try: () => NodeFSP.symlink(input.target, input.link, "junction"),
        catch: (cause) =>
          new CodexShadowHomeFileSystemError({
            ...context,
            operation: "junction",
            path: input.link,
            targetPath: input.target,
            cause,
          }),
      });
    }
    yield* input.fileSystem.link(input.target, input.link).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeHardLinkError({
            ...context,
            linkPath: input.link,
            targetPath: input.target,
            cause,
          }),
      }),
    );
    input.hardLinked.add(input.entryName);
  },
);

const ensureSymlink = Effect.fn("CodexHomeLayout.ensureSymlink")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly platform: NodeJS.Platform;
  readonly sharedHomePath: string;
  readonly effectiveHomePath: string;
  readonly entryName: string;
  readonly hardLinked: Set<string>;
}): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
  const path = yield* Path.Path;
  const target = path.join(input.sharedHomePath, input.entryName);
  const link = path.join(input.effectiveHomePath, input.entryName);
  const state = yield* readLinkState({
    ...input,
    linkPath: link,
  });
  const recorded = input.hardLinked.delete(input.entryName);

  const createLink = input.fileSystem.symlink(target, link).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        input.platform === "win32" && hasErrorCode(cause, "EPERM")
          ? createWindowsFallbackLink({ ...input, target, link })
          : new CodexShadowHomeFileSystemError({
              sharedHomePath: input.sharedHomePath,
              effectiveHomePath: input.effectiveHomePath,
              operation: "symlink",
              path: link,
              targetPath: target,
              entryName: input.entryName,
              cause,
            }),
    }),
  );

  if (state._tag === "NotSymlink") {
    if (input.platform === "win32" && (yield* isSameFile(link, target))) {
      if (recorded) input.hardLinked.add(input.entryName);
      return;
    }
    // A writer that replaces the shared file by rename leaves the fallback's hard link on the old
    // file, which a symlink would have followed. Until this setup re-links it, the shadow home
    // reads the old content. A file the fallback did not record is the user's and still conflicts.
    if (recorded) {
      yield* input.fileSystem.remove(link).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            new CodexShadowHomeFileSystemError({
              sharedHomePath: input.sharedHomePath,
              effectiveHomePath: input.effectiveHomePath,
              operation: "remove",
              path: link,
              entryName: input.entryName,
              cause,
            }),
        }),
      );
      return yield* createLink;
    }
    if (!REPLACEABLE_SHARED_RUNTIME_ENTRIES.has(input.entryName)) {
      return yield* new CodexShadowHomeEntryConflictError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName: input.entryName,
        linkPath: link,
        targetPath: target,
      });
    }

    if (input.entryName === "thread-writer-locks") {
      const lockNames = yield* input.fileSystem.readDirectory(link).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            new CodexShadowHomeFileSystemError({
              sharedHomePath: input.sharedHomePath,
              effectiveHomePath: input.effectiveHomePath,
              operation: "readDirectory",
              path: link,
              entryName: input.entryName,
              cause,
            }),
        }),
      );
      // Codex deletes a thread lock on release, so one that is left may still guard a live
      // writer. Keep the local directory until a later setup finds none.
      if (lockNames.some((name) => name.endsWith(".lock") && name !== ".coordination.lock")) {
        return yield* Effect.logWarning(
          "Codex shadow home still has thread writer locks; it will share them on a later setup.",
          { path: link },
        );
      }
    }

    yield* input.fileSystem.remove(link, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: link,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
    return yield* createLink;
  }

  if (state._tag === "Missing") {
    return yield* createLink;
  }

  const resolvedExisting = path.resolve(path.dirname(link), state.target);
  if (resolvedExisting !== target) {
    yield* input.fileSystem.remove(link).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: input.sharedHomePath,
            effectiveHomePath: input.effectiveHomePath,
            operation: "remove",
            path: link,
            entryName: input.entryName,
            cause,
          }),
      }),
    );
    yield* createLink;
  }
});

const ensureShadowAuthIsPrivate = Effect.fn("CodexHomeLayout.ensureShadowAuthIsPrivate")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly sharedHomePath: string;
    readonly effectiveHomePath: string;
  }): Effect.fn.Return<void, CodexShadowHomeError, Path.Path> {
    const path = yield* Path.Path;
    const entryName = "auth.json";
    const authPath = path.join(input.effectiveHomePath, entryName);
    const state = yield* readLinkState({
      ...input,
      entryName,
      linkPath: authPath,
    });
    if (state._tag === "Symlink") {
      return yield* new CodexShadowHomePrivateEntrySymlinkError({
        sharedHomePath: input.sharedHomePath,
        effectiveHomePath: input.effectiveHomePath,
        entryName,
        path: authPath,
      });
    }
  },
);

const HardLinkRecordJson = Schema.fromJsonString(
  Schema.Struct({ hardLinks: Schema.Array(Schema.String) }),
);
const decodeHardLinkRecord = Schema.decodeUnknownOption(HardLinkRecordJson);
const encodeHardLinkRecord = Schema.encodeSync(HardLinkRecordJson);

// A missing or unreadable record means no entry was recorded, so every differing file takes
// upstream's conflict path.
const readHardLinkRecord = (fileSystem: FileSystem.FileSystem, recordPath: string) =>
  fileSystem.readFileString(recordPath).pipe(
    Effect.map((contents) =>
      Option.match(decodeHardLinkRecord(contents), {
        onNone: (): ReadonlyArray<string> => [],
        onSome: (record) => record.hardLinks,
      }),
    ),
    Effect.catchTags({ PlatformError: () => Effect.succeed<ReadonlyArray<string>>([]) }),
  );

export const materializeCodexShadowHome = Effect.fn("materializeCodexShadowHome")(function* (
  layout: CodexHomeLayout,
) {
  if (layout.mode !== "authOverlay") return;
  const effectiveHomePath = layout.effectiveHomePath;
  if (!effectiveHomePath) return;
  if (layout.sharedHomePath === effectiveHomePath) {
    return yield* new CodexShadowHomePathConflictError({
      sharedHomePath: layout.sharedHomePath,
      effectiveHomePath,
    });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;

  const makeDirectory = (directoryPath: string) =>
    fileSystem.makeDirectory(directoryPath, { recursive: true }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          new CodexShadowHomeFileSystemError({
            sharedHomePath: layout.sharedHomePath,
            effectiveHomePath,
            operation: "makeDirectory",
            path: directoryPath,
            cause,
          }),
      }),
    );

  yield* Effect.all(
    [
      makeDirectory(layout.sharedHomePath),
      makeDirectory(effectiveHomePath),
      ...KNOWN_SHARED_DIRECTORIES.map((directory) =>
        makeDirectory(path.join(layout.sharedHomePath, directory)),
      ),
    ],
    { concurrency: "unbounded" },
  );

  const sharedEntryNames = yield* fileSystem.readDirectory(layout.sharedHomePath).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        new CodexShadowHomeFileSystemError({
          sharedHomePath: layout.sharedHomePath,
          effectiveHomePath,
          operation: "readDirectory",
          path: layout.sharedHomePath,
          cause,
        }),
    }),
  );
  const entries = new Set<string>(KNOWN_SHARED_DIRECTORIES);
  for (const entryName of sharedEntryNames) {
    if (!PRIVATE_ENTRY_NAMES.has(entryName) && !SHADOW_LOCAL_ENTRY_NAMES.has(entryName)) {
      entries.add(entryName);
    }
  }

  yield* Effect.forEach(
    PRIVATE_ENTRY_NAMES,
    (entryName) =>
      entryName === "auth.json"
        ? Effect.void
        : removePrivateSymlink({
            fileSystem,
            sharedHomePath: layout.sharedHomePath,
            effectiveHomePath,
            entryName,
          }),
    { discard: true },
  );

  const recordPath = path.join(effectiveHomePath, HARD_LINK_RECORD_NAME);
  const previousRecord = (yield* readHardLinkRecord(fileSystem, recordPath)).toSorted();
  const hardLinked = new Set(previousRecord);
  yield* Effect.forEach(
    entries,
    (entryName) => {
      if (PRIVATE_ENTRY_NAMES.has(entryName)) {
        return Effect.void;
      }
      return ensureSymlink({
        fileSystem,
        platform,
        sharedHomePath: layout.sharedHomePath,
        effectiveHomePath,
        entryName,
        hardLinked,
      });
    },
    { discard: true },
  );
  const nextRecord = [...hardLinked].toSorted();
  if (
    nextRecord.length !== previousRecord.length ||
    nextRecord.some((name, index) => name !== previousRecord[index])
  ) {
    yield* fileSystem
      .writeFileString(recordPath, encodeHardLinkRecord({ hardLinks: nextRecord }))
      .pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            new CodexShadowHomeFileSystemError({
              sharedHomePath: layout.sharedHomePath,
              effectiveHomePath,
              operation: "writeFile",
              path: recordPath,
              cause,
            }),
        }),
      );
  }

  yield* ensureShadowAuthIsPrivate({
    fileSystem,
    sharedHomePath: layout.sharedHomePath,
    effectiveHomePath,
  });
});

export function codexContinuationIdentity(layout: CodexHomeLayout) {
  return {
    driverKind: ProviderDriverKind.make("codex"),
    continuationKey: layout.continuationKey,
  };
}
