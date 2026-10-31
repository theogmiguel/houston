// @effect-diagnostics nodeBuiltinImport:off - checks the destination and opens carried files.
// houston.transfer.export: reads one project's threads, code state and Houston rows and writes them
// to one encrypted file. It reads git output, carried files and rows; never the keychain.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2PlanArtifact,
  OrchestrationV2TurnItem,
  ThreadId,
  type ChatAttachment,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  type HoustonTransferError,
  type HoustonTransferExportInput,
  type HoustonTransferExportSummary,
  type HoustonTransferManifest,
  type HoustonTransferManifestCheckout,
  type HoustonTransferManifestThread,
  type HoustonTransferSkippedThread,
  type HoustonTransferThread,
} from "@t3tools/contracts/houston/transfer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import packageJson from "../../../package.json" with { type: "json" };
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { makeIsManagedWorktreePath } from "../../worktreesDirectory.ts";
import { captureCheckout, checkCheckoutNames, isGitCheckout, originUrl } from "./checkout.ts";
import {
  bytesEntry,
  fileEntry,
  fromPromise,
  writeTransferFile,
  type FormatLimits,
  type PackEntry,
} from "./format.ts";
import { TransferProbe } from "./probe.ts";
import {
  checkDestination,
  checkPassphrase,
  checkRenderer,
  isFinishedRun,
  pathProblem,
  refusal,
  stripRemoteCredentials,
  transferFileName,
} from "./rules.ts";
import { SECTIONS } from "./sections.ts";

const OPERATION = "houston.transfer.export";
export const OUTSIDE_REASON = "runs in a folder outside the project and its managed worktrees";

export interface ExportOptions {
  readonly limits?: Partial<FormatLimits>;
  readonly workFactor?: number;
}

/** Hands the export each stage; the service publishes it and holds the project's slot. */
export type StageReporter = (stage: "checking" | "packing" | "done") => Effect.Effect<void>;

const jsonLine = <S extends Schema.Top>(schema: S) => {
  const encode = Schema.encodeUnknownSync(Schema.toCodecJson(schema as never));
  return (kind: string, value: unknown) => JSON.stringify({ kind, value: encode(value) });
};
const encodeThread = Schema.encodeUnknownSync(Schema.toCodecJson(OrchestrationV2AppThread));
const messageLine = jsonLine(OrchestrationV2ConversationMessage);
const itemLine = jsonLine(OrchestrationV2TurnItem);
const planLine = jsonLine(OrchestrationV2PlanArtifact);

const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");

/** `thread.json`: the thread record as upstream's schema encodes it. */
const threadFile = (projection: OrchestrationV2ThreadProjection) =>
  jsonBytes(encodeThread(projection.thread));

/** `history.ndjson`: messages, turn items and proposed plans, one encoded record per line. */
const historyFile = (projection: OrchestrationV2ThreadProjection) =>
  Buffer.from(
    [
      ...projection.messages.map((message) => messageLine("message", message)),
      ...projection.turnItems.map((item) => itemLine("turnItem", item)),
      ...projection.plans.map((plan) => planLine("plan", plan)),
    ]
      .map((line) => `${line}\n`)
      .join(""),
    "utf8",
  );

/** The `houston_transfer_exports` JSON columns: carried threads and each checkout's position. */
const exportRecord = (
  threads: ReadonlyArray<HoustonTransferThread>,
  checkouts: ReadonlyArray<HoustonTransferManifestCheckout>,
) => ({
  threads: JSON.stringify(threads),
  treeState: JSON.stringify(
    checkouts.map(({ key, path, branch, head, untracked }) => ({
      key,
      path,
      branch,
      head,
      untracked,
    })),
  ),
});

/** What keeps a thread busy, as the refusal names it; null when it is idle. */
const busyState = (projection: OrchestrationV2ThreadProjection): string | null => {
  const run = projection.runs.find((entry) => !isFinishedRun(entry.status));
  if (run !== undefined) return run.status;
  if (projection.runtimeRequests.some((request) => request.status === "pending")) {
    return "waiting for an answer";
  }
  const attempt = projection.attempts.find(
    (entry) => entry.status === "pending" || entry.status === "running",
  );
  return attempt === undefined ? null : attempt.status;
};

export const runExport = Effect.fn("HoustonTransfer.export")(function* (
  input: HoustonTransferExportInput,
  options: ExportOptions,
  claim: (title: string) => Effect.Effect<StageReporter, HoustonTransferError, Scope.Scope>,
) {
  const passphrase = Redacted.value(input.passphrase);
  const passphraseRefusal = checkPassphrase(passphrase, OPERATION);
  if (passphraseRefusal !== null) return yield* passphraseRefusal;
  const rendererRefusal = checkRenderer(input.renderer, OPERATION);
  if (rendererRefusal !== null) return yield* rendererRefusal;

  const projects = yield* ProjectStore.ProjectStoreV2;
  const project = Option.getOrNull(yield* projects.get(input.projectId).pipe(Effect.orDie));
  if (project === null) {
    return yield* refusal("not_found", OPERATION, `${input.projectId} is not a project here.`, {
      items: [input.projectId],
      steps: ["Choose a project that exists, then export again."],
    });
  }

  const file = NodePath.isAbsolute(input.destination)
    ? transferFileName(input.destination)
    : input.destination;
  const destinationRefusal = checkDestination({
    destination: file,
    folderExists:
      NodeFS.statSync(NodePath.dirname(file), { throwIfNoEntry: false })?.isDirectory() === true,
    fileExists: NodeFS.existsSync(file),
    overwrite: input.overwrite === true,
  });
  if (destinationRefusal !== null) return yield* destinationRefusal;

  const report = yield* claim(project.title);
  yield* report("checking");
  const root = project.workspaceRoot;
  if (!NodeFS.existsSync(root) || !(yield* isGitCheckout(root))) {
    return yield* refusal(
      "not_git_repository",
      OPERATION,
      `${root} is not a git repository, and a transfer carries code through git.`,
      {
        items: [root],
        steps: [
          "Run git init and commit the project, or choose a project that is a git repository.",
        ],
      },
    );
  }

  // The project's threads, in the order they were created.
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const isManaged = yield* makeIsManagedWorktreePath;
  const threadIds = yield* sql<{ readonly thread_id: string }>`
    SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE project_id = ${input.projectId} AND deleted_at IS NULL
    ORDER BY created_at, rowid
  `.pipe(Effect.orDie);
  const checkouts: Array<{ readonly key: string; readonly path: string }> = [
    { key: "root", path: root },
  ];
  const carried: Array<{
    readonly projection: OrchestrationV2ThreadProjection;
    readonly checkout: string;
  }> = [];
  const skipped: Array<HoustonTransferSkippedThread> = [];
  const busy: Array<string> = [];
  for (const { thread_id } of threadIds) {
    const projection = yield* store
      .getThreadProjection(ThreadId.make(thread_id))
      .pipe(Effect.orDie);
    const { thread } = projection;
    const folder = thread.worktreePath;
    let checkout: string | null = null;
    if (folder === null || NodePath.resolve(folder) === NodePath.resolve(root)) checkout = "root";
    else if (yield* isManaged(folder)) {
      const known = checkouts.find((entry) => entry.path === folder);
      checkout = known?.key ?? `worktree:${checkouts.length}`;
      if (known === undefined) checkouts.push({ key: checkout, path: folder });
    }
    if (checkout === null) {
      skipped.push({ threadId: thread.id, title: thread.title, reason: OUTSIDE_REASON });
      continue;
    }
    const state = busyState(projection);
    if (state !== null) busy.push(`${thread.title}: ${state}`);
    carried.push({ projection, checkout });
  }
  if (busy.length > 0) {
    return yield* refusal(
      "busy_threads",
      OPERATION,
      `${busy.length === 1 ? "A thread" : `${busy.length} threads`} of ${project.title} still ${busy.length === 1 ? "runs" : "run"}, and a transfer carries only finished turns.`,
      {
        items: busy,
        steps: ["Let each listed thread finish its turn, or answer or stop it, then export again."],
      },
    );
  }
  const [taskCount] = yield* sql<{ readonly n: number }>`
    SELECT count(*) AS n FROM houston_tasks WHERE project_id = ${input.projectId}
  `.pipe(Effect.orDie);
  if (carried.length === 0 && (taskCount?.n ?? 0) === 0) {
    return yield* refusal(
      "nothing_to_transfer",
      OPERATION,
      `${project.title} has no thread or task to transfer.`,
      {
        items: skipped.map((entry) => `${entry.title}: ${entry.reason}`),
        steps: ["Start a thread in the project or its managed worktrees, then export again."],
      },
    );
  }
  // Names are checked in every checkout before any carried file is opened.
  for (const checkout of checkouts) {
    yield* checkCheckoutNames(checkout.path, checkout.key === "root" ? null : checkout.path);
  }

  yield* report("packing");
  const config = yield* ServerConfig.ServerConfig;
  const probe = yield* TransferProbe;
  const transferId = NodeCrypto.randomUUID();
  const scratch = NodePath.join(config.baseDir, "houston", "transfer", "scratch", transferId);
  const pack = Effect.gen(function* () {
    const entries: Array<PackEntry> = [];
    const addFile = (name: string, path: string) =>
      fromPromise(() => fileEntry(name, path, probe.onFileRead)).pipe(
        Effect.map((entry) => entries.push(entry)),
      );
    const manifestCheckouts: Array<HoustonTransferManifestCheckout> = [];
    const skippedPaths: Array<string> = [];
    for (const [index, checkout] of checkouts.entries()) {
      const archiveDir = `checkouts/${index}`;
      const captured = yield* captureCheckout(
        checkout.path,
        NodePath.join(scratch, "checkouts", String(index)),
      );
      if (captured.bundle !== null) yield* addFile(`${archiveDir}/head.bundle`, captured.bundle);
      if (captured.diff !== null) yield* addFile(`${archiveDir}/tracked.diff`, captured.diff);
      for (const relative of captured.untracked) {
        yield* addFile(
          `${archiveDir}/untracked/${relative}`,
          NodePath.join(checkout.path, ...relative.split("/")),
        );
      }
      skippedPaths.push(
        ...captured.skippedPaths.map((path) =>
          checkout.key === "root" ? path : `${path} (in ${checkout.path})`,
        ),
      );
      manifestCheckouts.push({
        key: checkout.key,
        path: checkout.path,
        branch: captured.branch,
        head: captured.head,
        bundle: captured.bundle === null ? null : `${archiveDir}/head.bundle`,
        diff: captured.diff === null ? null : `${archiveDir}/tracked.diff`,
        untracked: captured.untracked,
        skippedPaths: captured.skippedPaths,
        archiveDir,
      });
    }

    const manifestThreads: Array<HoustonTransferManifestThread> = [];
    const summaryThreads: Array<HoustonTransferThread> = [];
    let attachmentCount = 0;
    for (const [index, { projection, checkout }] of carried.entries()) {
      const { thread } = projection;
      const archiveDir = `threads/${index}`;
      entries.push(
        bytesEntry(`${archiveDir}/thread.json`, threadFile(projection)),
        bytesEntry(`${archiveDir}/history.ndjson`, historyFile(projection)),
      );
      const attachments: Array<string> = [];
      const seen = new Set<string>();
      for (const attachment of projection.messages.flatMap(
        (message) => message.attachments as ReadonlyArray<ChatAttachment>,
      )) {
        if (attachment.type !== "image" || seen.has(attachment.id)) continue;
        seen.add(attachment.id);
        const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
        if (path === null || !NodeFS.existsSync(path) || pathProblem(attachment.id) !== null)
          continue;
        const name = `${archiveDir}/attachments/${attachment.id}`;
        yield* addFile(name, path);
        attachments.push(name);
      }
      attachmentCount += attachments.length;
      manifestThreads.push({
        sourceId: thread.id,
        title: thread.title,
        provider: thread.providerInstanceId,
        checkout,
        relCwd: "",
        archiveDir,
        attachments,
      });
      summaryThreads.push({
        threadId: thread.id,
        title: thread.title,
        provider: thread.providerInstanceId,
        checkout: checkout as HoustonTransferThread["checkout"],
      });
    }

    const scope = {
      projectId: input.projectId,
      checkoutRoots: checkouts.map((entry) => entry.path),
    };
    const sections: Record<string, { version: number; archivePath: string }> = {};
    const counts = { tasks: 0, taskSourceLinks: 0, viewedFiles: 0, attachments: attachmentCount };
    for (const section of SECTIONS) {
      const tables = yield* section.exportRows(scope).pipe(Effect.orDie);
      const archivePath = `sections/${section.name}.json`;
      entries.push(bytesEntry(archivePath, jsonBytes({ version: section.version, tables })));
      sections[section.name] = { version: section.version, archivePath };
      counts.tasks += tables.houston_tasks?.length ?? 0;
      counts.taskSourceLinks += tables.houston_task_source_links?.length ?? 0;
      counts.viewedFiles += tables.houston_review_files_viewed?.length ?? 0;
    }

    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const manifest: Omit<HoustonTransferManifest, "entries"> = {
      format: 2,
      transferId,
      createdAt,
      sourceOs: (yield* HostProcess.Platform) === "win32" ? "win32" : "linux",
      houstonVersion: packageJson.version,
      project: {
        title: project.title,
        root,
        remoteUrl: stripRemoteCredentials(yield* originUrl(root)),
      },
      checkouts: manifestCheckouts,
      threads: manifestThreads,
      skipped,
      sections,
      counts,
      renderer: input.renderer ?? null,
      lineage: [],
    };
    const written = yield* fromPromise(() =>
      writeTransferFile({
        file,
        passphrase,
        manifest,
        entries,
        ...(options.workFactor === undefined ? {} : { workFactor: options.workFactor }),
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      }),
    );
    const record = exportRecord(summaryThreads, manifestCheckouts);
    yield* sql`
      INSERT INTO houston_transfer_exports (
        transfer_id, project_id, file, bytes, threads_json, tree_state_json, created_at
      ) VALUES (
        ${transferId}, ${input.projectId}, ${file}, ${written.bytes}, ${record.threads},
        ${record.treeState}, ${createdAt}
      )
    `.pipe(Effect.orDie);
    return {
      transferId,
      file,
      bytes: written.bytes,
      threads: summaryThreads,
      skipped,
      skippedPaths,
    } satisfies HoustonTransferExportSummary;
  });
  const summary = yield* pack.pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(scratch, { recursive: true, force: true }))),
  );
  yield* report("done");
  return summary;
});
