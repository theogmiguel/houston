import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ProjectId, ThreadId } from "../baseSchemas.ts";

/** The bounds a transfer is checked against; a refusal names the bound and the value. */
export const HOUSTON_TRANSFER_LIMITS = {
  /** The encrypted file. */
  fileBytes: 209_715_200,
  /** Every entry's bytes together. */
  unpackedBytes: 4_294_967_296,
  manifestBytes: 33_554_432,
  entries: 100_000,
  rendererBytes: 1_048_576,
  passphraseMinCharacters: 12,
  passphraseMaxBytes: 1_024,
  /** scrypt's log2 cost at export, and the most an imported header may ask. */
  exportWorkFactor: 18,
  maxWorkFactor: 20,
} as const;

export const HOUSTON_TRANSFER_FORMAT = 2;
export const HOUSTON_TRANSFER_EXTENSION = ".houston-transfer";

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
);
const BoundedPath = Schema.String.check(Schema.isMaxLength(4_096));

export const HoustonTransferSourceOs = Schema.Literals(["linux", "win32"]);
export type HoustonTransferSourceOs = typeof HoustonTransferSourceOs.Type;

/** `root`, or `worktree:<n>` for the n-th carried managed worktree. */
export const HoustonTransferCheckoutKey = Schema.String.check(
  Schema.isPattern(/^(?:root|worktree:[0-9]{1,6})$/),
);

export const HoustonTransferManifestCheckout = Schema.Struct({
  key: HoustonTransferCheckoutKey,
  /** The checkout's folder on the exporting computer. */
  path: Schema.String,
  /** Null on a detached HEAD. */
  branch: Schema.NullOr(Schema.String),
  head: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/)),
  /** Entry names; null when there is nothing to carry. */
  bundle: Schema.NullOr(Schema.String),
  diff: Schema.NullOr(Schema.String),
  /** `/`-separated paths relative to the checkout, each carried as `<archiveDir>/untracked/<path>`. */
  untracked: Schema.Array(Schema.String),
  skippedPaths: Schema.Array(Schema.String),
  archiveDir: Schema.String.check(Schema.isPattern(/^checkouts\/[0-9]{1,6}$/)),
});
export type HoustonTransferManifestCheckout = typeof HoustonTransferManifestCheckout.Type;

export const HoustonTransferManifestThread = Schema.Struct({
  sourceId: Schema.String,
  title: Schema.String,
  /** The provider instance the thread ran on. */
  provider: Schema.String,
  checkout: HoustonTransferCheckoutKey,
  /** The thread's folder relative to its checkout; "" for the checkout itself. */
  relCwd: Schema.String,
  archiveDir: Schema.String.check(Schema.isPattern(/^threads\/[0-9]{1,6}$/)),
  /** Entry names of its image attachments. */
  attachments: Schema.Array(Schema.String),
});
export type HoustonTransferManifestThread = typeof HoustonTransferManifestThread.Type;

export const HoustonTransferSkippedThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  reason: Schema.String,
});
export type HoustonTransferSkippedThread = typeof HoustonTransferSkippedThread.Type;

export const HoustonTransferCounts = Schema.Struct({
  tasks: NonNegativeInt,
  taskSourceLinks: NonNegativeInt,
  viewedFiles: NonNegativeInt,
  attachments: NonNegativeInt,
});
export type HoustonTransferCounts = typeof HoustonTransferCounts.Type;

export const HoustonTransferManifest = Schema.Struct({
  format: Schema.Literal(HOUSTON_TRANSFER_FORMAT),
  transferId: Uuid,
  createdAt: IsoDateTime,
  sourceOs: HoustonTransferSourceOs,
  houstonVersion: Schema.String,
  project: Schema.Struct({
    title: Schema.String,
    root: Schema.String,
    /** `origin` without credentials, or null without one. */
    remoteUrl: Schema.NullOr(Schema.String),
  }),
  checkouts: Schema.Array(HoustonTransferManifestCheckout),
  threads: Schema.Array(HoustonTransferManifestThread),
  skipped: Schema.Array(HoustonTransferSkippedThread),
  sections: Schema.Record(
    Schema.String,
    Schema.Struct({ version: NonNegativeInt, archivePath: Schema.String }),
  ),
  counts: HoustonTransferCounts,
  renderer: Schema.NullOr(Schema.String),
  entries: Schema.Array(
    Schema.Struct({ name: Schema.String, size: NonNegativeInt, sha256: Sha256 }),
  ),
  /** Earlier exports this file descends from, oldest first. */
  lineage: Schema.Array(Schema.Struct({ transferId: Uuid, exportedAt: IsoDateTime })),
});
export type HoustonTransferManifest = typeof HoustonTransferManifest.Type;

/** A manifest as the reader decodes one: an unknown field is refused, not ignored. */
export const decodeHoustonTransferManifest = Schema.decodeUnknownExit(HoustonTransferManifest, {
  onExcessProperty: "error",
});

export const HoustonTransferOperation = Schema.Literals(["export", "import"]);
export type HoustonTransferOperation = typeof HoustonTransferOperation.Type;

export const HoustonTransferStage = Schema.Literals([
  "checking",
  "packing",
  "decrypting",
  "restoring_code",
  "importing_threads",
  "placing_conversations",
  "done",
  "undoing",
]);
export type HoustonTransferStage = typeof HoustonTransferStage.Type;

export const HoustonTransferRunning = Schema.Struct({
  operation: HoustonTransferOperation,
  projectId: ProjectId,
  stage: HoustonTransferStage,
});
export type HoustonTransferRunning = typeof HoustonTransferRunning.Type;

/** First the transfers running when the client subscribed, then one event per stage change. */
export const HoustonTransferStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("running"), running: Schema.Array(HoustonTransferRunning) }),
  Schema.Struct({
    type: Schema.Literal("stage"),
    operation: HoustonTransferOperation,
    projectId: ProjectId,
    stage: HoustonTransferStage,
  }),
]);
export type HoustonTransferStreamEvent = typeof HoustonTransferStreamEvent.Type;

export const HoustonTransferErrorKind = Schema.Literals([
  "invalid",
  "limit",
  "not_found",
  "busy",
  "not_git_repository",
  "busy_threads",
  "unportable_names",
  "partially_staged",
  "secret_files",
  "nothing_to_transfer",
  "too_large",
  "destination_exists",
  "wrong_passphrase",
  "not_transfer_file",
  "houston1_file",
  "unknown_format",
  "other_operating_system",
  "dirty_checkout",
  "missing_commits",
  "branch_diverged",
  "branch_checked_out",
  "paths_exist",
  "changes_do_not_apply",
  "already_imported",
  "return_tree_changed",
  "import_undone",
]);
export type HoustonTransferErrorKind = typeof HoustonTransferErrorKind.Type;

/** `items` lists at most 20 values and counts the rest; no error carries the passphrase. */
export class HoustonTransferError extends Schema.TaggedError<HoustonTransferError>()(
  "HoustonTransferError",
  {
    kind: HoustonTransferErrorKind,
    problem: Schema.String,
    items: Schema.Array(Schema.String),
    steps: Schema.Array(Schema.String),
    limit: Schema.optional(Schema.Number),
    actual: Schema.optional(Schema.Number),
    operation: Schema.String,
  },
) {}

export const HoustonTransferThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  provider: Schema.String,
  checkout: HoustonTransferCheckoutKey,
});
export type HoustonTransferThread = typeof HoustonTransferThread.Type;

// Inputs and results.

export const HoustonTransferExportInput = Schema.Struct({
  projectId: ProjectId,
  /** An absolute file path; `.houston-transfer` is appended when it lacks the extension. */
  destination: BoundedPath,
  passphrase: Schema.Redacted(Schema.String),
  overwrite: Schema.optionalKey(Schema.Boolean),
  /** The renderer's own state, returned unchanged by import. */
  renderer: Schema.optionalKey(Schema.String),
});
export type HoustonTransferExportInput = typeof HoustonTransferExportInput.Type;

export const HoustonTransferExportSummary = Schema.Struct({
  transferId: Schema.String,
  file: Schema.String,
  bytes: NonNegativeInt,
  threads: Schema.Array(HoustonTransferThread),
  skipped: Schema.Array(HoustonTransferSkippedThread),
  skippedPaths: Schema.Array(Schema.String),
});
export type HoustonTransferExportSummary = typeof HoustonTransferExportSummary.Type;

export const HoustonTransferInspectInput = Schema.Struct({
  file: BoundedPath,
  passphrase: Schema.Redacted(Schema.String),
});
export type HoustonTransferInspectInput = typeof HoustonTransferInspectInput.Type;

export const HoustonTransferFileSummary = Schema.Struct({
  transferId: Schema.String,
  format: Schema.Number,
  sourceOs: HoustonTransferSourceOs,
  source: Schema.Struct({
    title: Schema.String,
    root: Schema.String,
    remoteUrl: Schema.NullOr(Schema.String),
  }),
  createdAt: IsoDateTime,
  threads: Schema.Array(HoustonTransferThread),
  skipped: Schema.Array(HoustonTransferSkippedThread),
  checkouts: Schema.Array(
    Schema.Struct({
      key: HoustonTransferCheckoutKey,
      branch: Schema.NullOr(Schema.String),
      head: Schema.String,
      carriesCommits: Schema.Boolean,
      untracked: NonNegativeInt,
      /** Carried untracked files that configure agents or tools, shown before an import. */
      agentConfigPaths: Schema.Array(Schema.String),
    }),
  ),
  counts: HoustonTransferCounts,
  /** The registered project whose `origin` matches the file's, if any. */
  proposedProjectId: Schema.NullOr(ProjectId),
  importedInto: Schema.Array(Schema.Struct({ projectId: ProjectId, importedAt: IsoDateTime })),
});
export type HoustonTransferFileSummary = typeof HoustonTransferFileSummary.Type;

export const HoustonTransferImportInput = Schema.Struct({
  file: BoundedPath,
  passphrase: Schema.Redacted(Schema.String),
  projectId: ProjectId,
});
export type HoustonTransferImportInput = typeof HoustonTransferImportInput.Type;

export const HoustonTransferImportResult = Schema.Struct({
  importId: Schema.String,
  transferId: Schema.String,
  projectId: ProjectId,
  threads: Schema.Array(Schema.Struct({ from: Schema.String, to: ThreadId })),
  tasks: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
  notes: Schema.Array(Schema.String),
  renderer: Schema.NullOr(Schema.String),
});
export type HoustonTransferImportResult = typeof HoustonTransferImportResult.Type;

export const HoustonTransferSubscribeInput = Schema.Struct({});
export type HoustonTransferSubscribeInput = typeof HoustonTransferSubscribeInput.Type;
