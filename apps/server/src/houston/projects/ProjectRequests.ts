/**
 * An agent outside full access asking to add one project folder. The server
 * resolves the folder before the card, waits while the user decides, and only
 * then rechecks access and performs the one approved creation.
 */
import {
  CommandId,
  type HoustonProjectRequestAnswerInput,
  HoustonProjectRequestError,
  type HoustonProjectRequestStatus,
  type ModelSelection,
  OrchestratorMcpFailure,
  type OrchestrationV2TurnItem,
  type Project,
  type ProjectId,
  type ProjectScript,
  ProjectId as ProjectIdSchema,
  type RunId,
  type ThreadId,
  TurnItemId,
} from "@houston-app/contracts";
import * as KeyedLock from "@houston-app/shared/KeyedLock";
import { expandHomePath } from "@houston-app/provider-core/server/pathExpansion";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as HostProcess from "@houston-app/shared/HostProcess";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";

type ProjectRequestItem = Extract<OrchestrationV2TurnItem, { readonly type: "project_request" }>;

const WAIT_TIMEOUT = Duration.minutes(10);
const POLL_INTERVAL = Duration.millis(500);

const stablePart = (value: string) => encodeURIComponent(value);

export interface ProjectRequestInput<R> {
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly title: string;
  readonly reason: string | undefined;
  readonly workspaceRoot: string | undefined;
  readonly createWorkspaceRootIfMissing: boolean | undefined;
  readonly defaultModelSelection: ModelSelection | null | undefined;
  readonly scripts: ReadonlyArray<ProjectScript> | undefined;
  readonly clientRequestId: string | undefined;
  /** The caller's access check, run again after approval and before writing. */
  readonly recheck: Effect.Effect<void, OrchestratorMcpFailure, R>;
}

export class ProjectRequests extends Context.Service<
  ProjectRequests,
  {
    readonly request: <R>(
      input: ProjectRequestInput<R>,
    ) => Effect.Effect<Project, OrchestratorMcpFailure, R>;
    readonly answer: (
      input: HoustonProjectRequestAnswerInput,
    ) => Effect.Effect<void, HoustonProjectRequestError>;
  }
>()("@houston-app/cli/houston/projects/ProjectRequests") {}

const failure = (message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const refused = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

const rejection = (card: ProjectRequestItem) => {
  switch (card.projectRequestStatus) {
    case "declined":
      return refused(
        `The user declined to add the project at ${card.workspaceRoot}. Don't ask again; ask them to add it in the app if they change their mind.`,
      );
    case "cancelled":
      return refused(
        `The add-project request for ${card.workspaceRoot} was cancelled. Ask again with a new clientRequestId only if the project is still needed.`,
      );
    case "failed":
      return failure(
        `Could not add the project at ${card.workspaceRoot}: ${card.failure ?? "the project could not be registered"}`,
      );
    default:
      return failure(`The add-project request for ${card.workspaceRoot} did not finish.`);
  }
};

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Control characters would let agent text act on the card beyond plain prose. */
const plainText = (value: string | undefined) =>
  (value ?? "").replaceAll(CONTROL_CHARACTERS, "").trim();

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;

  const readCard = (threadId: ThreadId, turnItemId: TurnItemId) =>
    threads
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["project_request"],
        messageRoles: [],
      })
      .pipe(
        Effect.mapError(
          (cause) => new HoustonProjectRequestError({ reason: "load_failed", cause }),
        ),
        Effect.map((records) => {
          const item = records.turnItems.find((candidate) => candidate.id === turnItemId);
          return item?.type === "project_request" && records.thread.deletedAt === null
            ? item
            : undefined;
        }),
      );

  type RecordCard = {
    readonly id: ProjectRequestItem["id"];
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly nodeId: NonNullable<ProjectRequestItem["nodeId"]>;
    readonly title: string;
    readonly reason: string;
    readonly workspaceRoot: string;
    readonly createsFolder: boolean;
    readonly createsRepository: boolean;
  };

  const recordCard = (card: ProjectRequestItem): RecordCard | undefined =>
    card.runId === null || card.nodeId === null
      ? undefined
      : {
          id: card.id,
          threadId: card.threadId,
          runId: card.runId,
          nodeId: card.nodeId,
          title: card.title,
          reason: card.reason,
          workspaceRoot: card.workspaceRoot,
          createsFolder: card.createsFolder,
          createsRepository: card.createsRepository,
        };

  const record = (
    card: RecordCard,
    projectRequestStatus: HoustonProjectRequestStatus,
    extra: { readonly projectId?: ProjectId; readonly failure?: string } = {},
  ) =>
    threads
      .dispatch({
        type: "project_request.record",
        commandId: CommandId.make(`project-request:${stablePart(card.id)}:${projectRequestStatus}`),
        threadId: card.threadId,
        runId: card.runId,
        nodeId: card.nodeId,
        turnItemId: card.id,
        title: card.title,
        reason: card.reason,
        workspaceRoot: card.workspaceRoot,
        createsFolder: card.createsFolder,
        createsRepository: card.createsRepository,
        projectRequestStatus,
        ...(extra.projectId === undefined ? {} : { projectId: extra.projectId }),
        ...(extra.failure === undefined ? {} : { failure: extra.failure }),
      })
      .pipe(
        Effect.mapError(
          (cause) => new HoustonProjectRequestError({ reason: "record_failed", cause }),
        ),
      );

  const recordFailure = (error: HoustonProjectRequestError) => failure(error.message);

  const resolveFolder = Effect.fn("ProjectRequests.resolveFolder")(function* (input: {
    readonly title: string;
    readonly workspaceRoot: string | undefined;
    readonly createWorkspaceRootIfMissing: boolean | undefined;
    readonly defaultModelSelection: ModelSelection | null | undefined;
    readonly scripts: ReadonlyArray<ProjectScript> | undefined;
  }) {
    if (input.workspaceRoot === undefined) {
      if (
        input.createWorkspaceRootIfMissing === true ||
        input.defaultModelSelection !== undefined ||
        input.scripts !== undefined ||
        input.title.trim().length === 0
      ) {
        return yield* invalid(
          "A project started from its title takes only a title; set scripts or defaultModelSelection afterwards with houston_project_update.",
        );
      }
      const workspaceRoot = yield* folders
        .planNamedProjectFolder({ name: input.title })
        .pipe(
          Effect.mapError((error) =>
            failure(`Could not choose a folder for the project: ${error.message}`),
          ),
        );
      return { workspaceRoot, createsFolder: true, createsRepository: true };
    }
    const resolved = path.resolve(
      expandHomePath(input.workspaceRoot.trim(), yield* HostProcess.HomeDirectory),
    );
    const stat = yield* fileSystem.stat(resolved).pipe(Effect.option);
    if (Option.isSome(stat) && stat.value.type !== "Directory") {
      return yield* invalid(
        `${input.workspaceRoot} is not a folder on this computer. Expected an existing folder.`,
      );
    }
    if (Option.isNone(stat) && input.createWorkspaceRootIfMissing !== true) {
      return yield* invalid(
        `${input.workspaceRoot} is not a folder on this computer. Expected an existing folder.`,
      );
    }
    return {
      workspaceRoot: resolved,
      createsFolder: Option.isNone(stat),
      createsRepository: false,
    };
  });

  const createProject = Effect.fn("ProjectRequests.createProject")(function* (
    card: ProjectRequestItem,
    payload: Pick<ProjectRequestInput<never>, "defaultModelSelection" | "scripts">,
  ) {
    const suffix = stablePart(card.id);
    const commandId = CommandId.make(`command:mcp:project-create:${suffix}`);
    const projectId = ProjectIdSchema.make(`project:mcp:${suffix}`);
    if (card.createsRepository) {
      const created = yield* folders
        .createNamedProjectAt({
          name: card.title,
          workspaceRoot: card.workspaceRoot,
          commandId,
          projectId,
        })
        .pipe(Effect.mapError((error) => failure(error.message)));
      const project = yield* projects
        .getById(created.projectId)
        .pipe(Effect.mapError((error) => failure(error.message)));
      if (Option.isNone(project)) return yield* failure("The new project could not be read.");
      return project.value;
    }
    return yield* projects
      .create({
        commandId,
        projectId,
        title: card.title,
        workspaceRoot: card.workspaceRoot,
        createWorkspaceRootIfMissing: card.createsFolder,
        ...(payload.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: payload.defaultModelSelection }),
        ...(payload.scripts === undefined ? {} : { scripts: payload.scripts }),
      })
      .pipe(Effect.mapError((error) => failure(error.message)));
  });

  const projectFor = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError(() => failure("The added project could not be read.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(failure("The added project could not be read.")),
          onSome: Effect.succeed,
        }),
      ),
    );

  const requestLocks = yield* KeyedLock.make<TurnItemId>();

  const execute = <R>(
    card: ProjectRequestItem,
    recheck: Effect.Effect<void, OrchestratorMcpFailure, R>,
    payload: Pick<ProjectRequestInput<never>, "defaultModelSelection" | "scripts">,
  ) =>
    requestLocks.withLock(
      card.id,
      Effect.gen(function* () {
        const latest = yield* readCard(card.threadId, card.id).pipe(Effect.mapError(recordFailure));
        if (latest === undefined)
          return yield* refused("This add-project request no longer exists.");
        if (latest.projectRequestStatus === "added" && latest.projectId !== undefined) {
          return yield* projectFor(latest.projectId);
        }
        if (latest.projectRequestStatus !== "adding") return yield* rejection(latest);
        const target = recordCard(latest);
        if (target === undefined) return yield* refused(rejection(latest).message);
        const records = yield* threads
          .getThreadRecords(card.threadId, ["runs"], { messageRoles: [] })
          .pipe(Effect.mapError(() => failure("The thread's runs could not be read.")));
        const run = records.runs.find((candidate) => candidate.id === card.runId);
        if (run === undefined || ThreadManagementService.isTerminalRunStatus(run.status)) {
          yield* record(target, "cancelled").pipe(
            Effect.mapError(recordFailure),
            Effect.catch(() => Effect.void),
          );
          return yield* refused(
            rejection({ ...latest, projectRequestStatus: "cancelled" }).message,
          );
        }
        yield* recheck.pipe(
          Effect.tapError((error) =>
            record(target, "cancelled").pipe(
              Effect.mapError(recordFailure),
              Effect.catch(() => Effect.void),
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );
        const project = yield* createProject(latest, payload).pipe(
          Effect.tapError((error) =>
            record(target, "failed", { failure: error.message }).pipe(Effect.ignore),
          ),
        );
        yield* record(target, "added", { projectId: project.id }).pipe(
          Effect.mapError(recordFailure),
        );
        return project;
      }),
    );

  const waitForDecision = Effect.fn("ProjectRequests.waitForDecision")(function* <R>(
    initial: ProjectRequestItem,
    recheck: Effect.Effect<void, OrchestratorMcpFailure, R>,
    payload: Pick<ProjectRequestInput<never>, "defaultModelSelection" | "scripts">,
  ) {
    let card = initial;
    while (true) {
      if (card.projectRequestStatus === "added" && card.projectId !== undefined) {
        return yield* projectFor(card.projectId);
      }
      if (card.projectRequestStatus === "adding") return yield* execute(card, recheck, payload);
      if (card.projectRequestStatus !== "pending") return yield* rejection(card);
      const records = yield* threads
        .getThreadRecords(card.threadId, ["runs"], { messageRoles: [] })
        .pipe(Effect.mapError(() => failure("The thread's runs could not be read.")));
      const run = records.runs.find((candidate) => candidate.id === card.runId);
      if (run === undefined || ThreadManagementService.isTerminalRunStatus(run.status)) {
        const target = recordCard(card);
        if (target !== undefined) {
          yield* record(target, "cancelled").pipe(
            Effect.mapError(recordFailure),
            Effect.catch(() => Effect.void),
          );
        }
        return yield* refused(rejection({ ...card, projectRequestStatus: "cancelled" }).message);
      }
      yield* Effect.sleep(POLL_INTERVAL);
      const next = yield* readCard(card.threadId, card.id).pipe(Effect.mapError(recordFailure));
      if (next === undefined) return yield* refused("This add-project request no longer exists.");
      card = next;
    }
  });

  const waitWithTimeout = Effect.fn("ProjectRequests.waitWithTimeout")(function* <R>(
    card: ProjectRequestItem,
    recheck: Effect.Effect<void, OrchestratorMcpFailure, R>,
    payload: Pick<ProjectRequestInput<never>, "defaultModelSelection" | "scripts">,
  ) {
    const settled = yield* waitForDecision(card, recheck, payload).pipe(
      Effect.timeoutOption(WAIT_TIMEOUT),
    );
    if (Option.isSome(settled)) return settled.value;
    const target = recordCard(card);
    if (target !== undefined) {
      yield* record(target, "cancelled").pipe(
        Effect.mapError(recordFailure),
        Effect.catch(() => Effect.void),
      );
    }
    return yield* refused(
      "No answer in time. Ask the user to add the folder in the app, then continue.",
    );
  });

  const request: ProjectRequests["Service"]["request"] = Effect.fn("ProjectRequests.request")(
    function* <R>(input: ProjectRequestInput<R>) {
      const scope = input.scope;
      if (scope.thread === undefined) {
        return yield* refused(
          "Adding a project needs the user's approval, and this MCP client is not running inside a Houston thread. Add the folder as a project in the app, then continue.",
        );
      }
      const threadId = scope.thread.threadId;
      const key = input.clientRequestId ?? (yield* random.uuidV4());
      const turnItemId = TurnItemId.make(
        `turn-item:project-request:${stablePart(threadId)}:${stablePart(scope.requestNamespace)}:${stablePart(key)}`,
      );
      const payload = {
        defaultModelSelection: input.defaultModelSelection,
        scripts: input.scripts,
      };
      const existing = yield* readCard(threadId, turnItemId).pipe(Effect.mapError(recordFailure));
      if (existing !== undefined) {
        return yield* waitWithTimeout(existing, input.recheck, payload);
      }
      const reason = plainText(input.reason);
      if (reason.length === 0) {
        return yield* invalid(
          "Pass reason: tell the user what the folder is for, so they can decide whether to add it.",
        );
      }
      const folder = yield* resolveFolder(input);
      const records = yield* threads
        .getThreadRecords(threadId, ["runs"], { messageRoles: [] })
        .pipe(Effect.mapError(() => failure("The thread's runs could not be read.")));
      const run = ThreadManagementService.latestActiveRun(records);
      if (
        run === undefined ||
        run.rootNodeId === null ||
        run.providerInstanceId !== scope.thread.providerInstanceId
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "parent_not_active",
          message:
            "Asking to add a project requires an active run owned by this MCP provider session.",
        });
      }
      const ask = {
        id: turnItemId,
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId,
        title: input.title,
        reason,
        ...folder,
      };
      yield* record(ask, "pending").pipe(Effect.mapError(recordFailure));
      const pending = yield* readCard(threadId, turnItemId).pipe(Effect.mapError(recordFailure));
      if (pending === undefined)
        return yield* failure("The add-project request could not be read.");
      return yield* waitWithTimeout(pending, input.recheck, payload);
    },
  );

  // One answer per card at a time; two clicks must not both move it.
  const answerLocks = yield* KeyedLock.make<TurnItemId>();
  const answer: ProjectRequests["Service"]["answer"] = Effect.fn("ProjectRequests.answer")(
    function* (input) {
      const card = yield* readCard(input.threadId, input.turnItemId);
      if (card === undefined || card.runId === null || card.nodeId === null) {
        return yield* new HoustonProjectRequestError({ reason: "not_found" });
      }
      if (card.projectRequestStatus !== "pending") {
        return yield* new HoustonProjectRequestError({ reason: "already_answered" });
      }
      const records = yield* threads
        .getThreadRecords(input.threadId, ["runs"], { messageRoles: [] })
        .pipe(
          Effect.mapError(
            (cause) => new HoustonProjectRequestError({ reason: "load_failed", cause }),
          ),
        );
      const run = records.runs.find((candidate) => candidate.id === card.runId);
      if (run === undefined || ThreadManagementService.isTerminalRunStatus(run.status)) {
        return yield* new HoustonProjectRequestError({ reason: "agent_stopped" });
      }
      const target = recordCard(card);
      if (target === undefined) {
        return yield* new HoustonProjectRequestError({ reason: "not_found" });
      }
      yield* record(target, input.answer.type === "approve" ? "adding" : "declined");
    },
    (effect, input) => answerLocks.withLock(input.turnItemId, effect),
  );

  return ProjectRequests.of({ request, answer });
});

export const layer = Layer.effect(ProjectRequests, make);
