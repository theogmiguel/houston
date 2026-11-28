import {
  type EnvironmentId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
  OrchestratorMcpFailure,
  type Project,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@houston-app/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { ProjectRequests, layer as projectRequestsLayer } from "./ProjectRequests.ts";

const environmentId = "environment:test" as EnvironmentId;
const threadId = ThreadId.make("thread:test");
const runId = RunId.make("run:test");
const nodeId = "node:root" as never;
const providerInstanceId = ProviderInstanceId.make("claudeAgent");
const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

type ProjectRequestCard = Extract<OrchestrationV2TurnItem, { readonly type: "project_request" }>;

interface Harness {
  readonly root: string;
  readonly existing: string;
  readonly cards: Map<string, ProjectRequestCard>;
  readonly dispatched: Array<{ readonly type?: string; readonly [key: string]: unknown }>;
  readonly created: Array<ProjectService.ProjectCreateInput>;
  readonly createdFolders: Array<string>;
  readonly projects: Map<string, Project>;
  readonly setRunStatus: (status: string) => void;
  readonly service: ProjectRequests["Service"];
  readonly exists: (path: string) => Effect.Effect<boolean>;
  readonly cardReady: Deferred.Deferred<TurnItemId>;
}

const recordCard = (
  command: Extract<OrchestrationV2ServerCommand, { readonly type: "project_request.record" }>,
  existing: ProjectRequestCard | undefined,
): ProjectRequestCard => {
  const waiting =
    command.projectRequestStatus === "pending" || command.projectRequestStatus === "adding";
  return {
    id: command.turnItemId,
    threadId: command.threadId,
    runId: command.runId,
    nodeId: command.nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: existing?.ordinal ?? 0,
    status: waiting
      ? "waiting"
      : command.projectRequestStatus === "added"
        ? "completed"
        : command.projectRequestStatus === "failed"
          ? "failed"
          : "cancelled",
    title: command.title,
    startedAt: existing?.startedAt ?? now,
    completedAt: waiting ? null : now,
    updatedAt: now,
    type: "project_request",
    reason: command.reason,
    workspaceRoot: command.workspaceRoot,
    createsFolder: command.createsFolder,
    createsRepository: command.createsRepository,
    projectRequestStatus: command.projectRequestStatus,
    ...(command.projectId === undefined ? {} : { projectId: command.projectId }),
    ...(command.failure === undefined ? {} : { failure: command.failure }),
  } as ProjectRequestCard;
};

const withService = <A, E>(
  options: {
    readonly runStatus?: "running" | "cancelled";
    readonly failRecheck?: boolean;
    readonly gateCreate?: {
      readonly started: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    };
  },
  body: (harness: Harness) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "houston-project-request-" });
      const existing = path.join(root, "code", "nps-research");
      yield* fs.makeDirectory(existing, { recursive: true });
      const cards = new Map<string, ProjectRequestCard>();
      const cardReady = yield* Deferred.make<TurnItemId>();
      const dispatched: Harness["dispatched"] = [];
      const created: Array<ProjectService.ProjectCreateInput> = [];
      const createdFolders: Array<string> = [];
      const projects = new Map<string, Project>();
      let runStatus = options.runStatus ?? "running";
      const project = (input: { id: string; title: string; workspaceRoot: string }): Project =>
        ({
          id: ProjectId.make(input.id),
          title: input.title,
          workspaceRoot: input.workspaceRoot,
          repositoryIdentity: null,
          faviconPath: null,
          defaultModelSelection: null,
          defaultThreadEnvMode: null,
          autoPull: false,
          projectIcon: null,
          scripts: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          deletedAt: null,
        }) as Project;

      const dependencies = Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId: ProjectId.make("project:test"), deletedAt: null },
              runs: [
                {
                  id: runId,
                  rootNodeId: nodeId,
                  providerInstanceId,
                  status: runStatus,
                  providerThreadId: null,
                },
              ],
              turnItems: [...cards.values()],
            } as never),
          dispatch: (command) =>
            Effect.gen(function* () {
              dispatched.push(command as never);
              if (command.type !== "project_request.record") return {} as never;
              const existingCard = cards.get(command.turnItemId);
              cards.set(command.turnItemId, recordCard(command, existingCard));
              if (existingCard === undefined && command.projectRequestStatus === "pending") {
                yield* Deferred.succeed(cardReady, command.turnItemId);
              }
              return {} as never;
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          create: (input) =>
            Effect.gen(function* () {
              if (options.gateCreate !== undefined) {
                yield* Deferred.succeed(options.gateCreate.started, undefined);
                yield* Deferred.await(options.gateCreate.release);
              }
              created.push(input);
              const value = project({
                id: input.projectId,
                title: input.title,
                workspaceRoot: input.workspaceRoot,
              });
              projects.set(input.projectId, value);
              return value;
            }),
          getById: (id) => Effect.succeed(Option.fromUndefinedOr(projects.get(id))),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: path.join(root, "projects"),
          planNamedProjectFolder: ({ name }) =>
            Effect.succeed(path.join(root, "projects", name.toLowerCase().replaceAll(" ", "-"))),
          createNamedProjectAt: (input) =>
            Effect.sync(() => {
              createdFolders.push(input.workspaceRoot);
              const id = input.projectId ?? ProjectId.make("project:new");
              projects.set(
                id,
                project({ id, title: input.name, workspaceRoot: input.workspaceRoot }),
              );
              return { projectId: id, workspaceRoot: input.workspaceRoot };
            }),
        }),
        Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
      );

      return yield* Effect.gen(function* () {
        const service = yield* ProjectRequests;
        return yield* body({
          root,
          existing,
          cards,
          dispatched,
          created,
          createdFolders,
          projects,
          setRunStatus: (status) => {
            runStatus = status as never;
          },
          service,
          exists: (target) => fs.exists(target).pipe(Effect.orElseSucceed(() => false)),
          cardReady,
        });
      }).pipe(Effect.provide(projectRequestsLayer.pipe(Layer.provide(dependencies))));
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const scope = {
  environmentId,
  requestNamespace: "session:test",
  thread: {
    threadId,
    providerSessionId: "session:test",
    providerInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};

const request = (
  service: ProjectRequests["Service"],
  options: {
    readonly workspaceRoot?: string;
    readonly reason?: string;
    readonly clientRequestId?: string;
    readonly recheck?: Effect.Effect<void, OrchestratorMcpFailure>;
  } = {},
) =>
  service.request({
    scope,
    title: "Research",
    reason: options.reason ?? "The repository holds the code the user asked about.",
    workspaceRoot: options.workspaceRoot,
    createWorkspaceRootIfMissing: false,
    defaultModelSelection: undefined,
    scripts: undefined,
    clientRequestId: options.clientRequestId ?? "add-1",
    recheck: options.recheck ?? Effect.void,
  });

describe("ProjectRequests", () => {
  it.live("approving registers the exact resolved folder once, and a retry adds nothing", () =>
    withService({}, (harness) =>
      Effect.gen(function* () {
        const service = harness.service;
        const running = yield* request(service, { workspaceRoot: harness.existing }).pipe(
          Effect.forkChild,
        );
        const id = yield* Deferred.await(harness.cardReady);
        yield* service.answer({ threadId, turnItemId: id, answer: { type: "approve" } });
        const project = yield* Fiber.join(running);
        expect(project.workspaceRoot).toBe(harness.existing);
        expect(harness.created).toHaveLength(1);
        expect(harness.created[0]?.workspaceRoot).toBe(harness.existing);
        expect(harness.cards.get(id)?.projectRequestStatus).toBe("added");

        const retried = yield* request(service, { workspaceRoot: harness.existing });
        expect(retried.id).toBe(project.id);
        expect(harness.created).toHaveLength(1);
        expect(harness.cards.size).toBe(1);
      }),
    ),
  );

  it.live(
    "declining registers nothing, creates no folder, and tells the agent not to ask again",
    () =>
      withService({}, (harness) =>
        Effect.gen(function* () {
          const service = harness.service;
          const running = yield* request(service, { workspaceRoot: harness.existing }).pipe(
            Effect.forkChild,
          );
          const id = yield* Deferred.await(harness.cardReady);
          yield* service.answer({ threadId, turnItemId: id, answer: { type: "decline" } });
          const error = yield* Fiber.join(running).pipe(Effect.flip);
          expect(error.code).toBe("capability_denied");
          expect(error.message).toContain("declined");
          expect(harness.created).toHaveLength(0);
          expect(yield* harness.exists(harness.existing)).toBe(true);
          expect(harness.cards.get(id)?.projectRequestStatus).toBe("declined");
        }),
      ),
  );

  it.live("stopping the run while the card waits registers nothing", () =>
    withService({}, (harness) =>
      Effect.gen(function* () {
        const running = yield* request(harness.service, { workspaceRoot: harness.existing }).pipe(
          Effect.forkChild,
        );
        const id = yield* Deferred.await(harness.cardReady);
        harness.setRunStatus("cancelled");
        const error = yield* Fiber.join(running).pipe(Effect.flip);
        expect(error.code).toBe("capability_denied");
        expect(harness.created).toHaveLength(0);
        expect(harness.cards.get(id)?.projectRequestStatus).toBe("cancelled");
      }),
    ),
  );

  it.live("access is checked again after approval and a refusal writes nothing", () =>
    withService({ failRecheck: true }, (harness) =>
      Effect.gen(function* () {
        const service = harness.service;
        const running = yield* request(service, {
          workspaceRoot: harness.existing,
          recheck: Effect.fail(
            new OrchestratorMcpFailure({
              code: "capability_denied",
              message: "The calling provider no longer owns an active thread run.",
            }),
          ),
        }).pipe(Effect.forkChild);
        const id = yield* Deferred.await(harness.cardReady);
        yield* service.answer({ threadId, turnItemId: id, answer: { type: "approve" } });
        const error = yield* Fiber.join(running).pipe(Effect.flip);
        expect(error.message).toContain("no longer owns");
        expect(harness.created).toHaveLength(0);
        expect(harness.cards.get(id)?.projectRequestStatus).toBe("cancelled");
      }),
    ),
  );

  it.live("a folder that is not on this computer is refused before any card", () =>
    withService({}, (harness) =>
      Effect.gen(function* () {
        const missing = `${harness.root}/code/nps-reserch`;
        const error = yield* request(harness.service, { workspaceRoot: missing }).pipe(Effect.flip);
        expect(error.message).toBe(
          `${missing} is not a folder on this computer. Expected an existing folder.`,
        );
        expect(harness.cards.size).toBe(0);
      }),
    ),
  );

  it.live("a title-only project plans one folder and creates a repository there", () =>
    withService({}, (harness) =>
      Effect.gen(function* () {
        const service = harness.service;
        const running = yield* request(service, {}).pipe(Effect.forkChild);
        const id = yield* Deferred.await(harness.cardReady);
        const planned = harness.cards.get(id)?.workspaceRoot ?? "";
        // Compared with one separator: Windows joins the planned folder with backslashes.
        expect(planned.replaceAll("\\", "/")).toBe(
          `${harness.root.replaceAll("\\", "/")}/projects/research`,
        );
        expect(harness.cards.get(id)?.createsRepository).toBe(true);
        yield* service.answer({ threadId, turnItemId: id, answer: { type: "approve" } });
        yield* Fiber.join(running);
        expect(harness.createdFolders).toEqual([planned]);
        expect(harness.created).toHaveLength(0);
      }),
    ),
  );
});

it.effect(
  "an approval after the waiting call is gone settles the card instead of leaving it adding",
  () =>
    withService({}, (harness) =>
      Effect.gen(function* () {
        const running = yield* request(harness.service, {
          workspaceRoot: harness.existing,
        }).pipe(Effect.forkChild);
        const id = yield* Deferred.await(harness.cardReady);
        yield* Fiber.interrupt(running);

        const error = yield* harness.service
          .answer({ threadId, turnItemId: id, answer: { type: "approve" } })
          .pipe(Effect.flip);
        expect(error.reason).toBe("call_dropped");
        expect(harness.cards.get(id)?.projectRequestStatus).toBe("cancelled");
        expect(harness.created).toHaveLength(0);
      }),
    ),
);

it.live("an interrupted adding card is settled without a second answer", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* withService({ gateCreate: { started, release } }, (harness) =>
      Effect.gen(function* () {
        const running = yield* request(harness.service, {
          workspaceRoot: harness.existing,
        }).pipe(Effect.forkChild);
        const id = yield* Deferred.await(harness.cardReady);
        yield* harness.service.answer({
          threadId,
          turnItemId: id,
          answer: { type: "approve" },
        });
        yield* Deferred.await(started);
        yield* Fiber.interrupt(running);

        expect(harness.cards.get(id)?.projectRequestStatus).toBe("cancelled");
        const error = yield* harness.service
          .answer({ threadId, turnItemId: id, answer: { type: "approve" } })
          .pipe(Effect.flip);
        expect(error.reason).toBe("already_answered");
        expect(harness.created).toHaveLength(0);
      }),
    );
  }),
);

it.effect("the wait timeout does not cancel a card whose creation already started", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* withService({ gateCreate: { started, release } }, (harness) =>
      Effect.gen(function* () {
        const running = yield* request(harness.service, {
          workspaceRoot: harness.existing,
        }).pipe(Effect.forkChild);
        const id = yield* Deferred.await(harness.cardReady);
        yield* harness.service.answer({
          threadId,
          turnItemId: id,
          answer: { type: "approve" },
        });
        yield* TestClock.adjust("500 millis");
        yield* Deferred.await(started);
        yield* TestClock.adjust("11 minutes");

        expect(harness.cards.get(id)?.projectRequestStatus).toBe("adding");

        yield* Deferred.succeed(release, undefined);
        const project = yield* Fiber.join(running);
        expect(project.workspaceRoot).toBe(harness.existing);
        expect(harness.cards.get(id)?.projectRequestStatus).toBe("added");
      }),
    );
  }),
);
