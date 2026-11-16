import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@houston-app/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { HoustonResumeSessions, layer as resumeSessionsLayer } from "./resumeSessions.ts";

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const providerThreadId = ProviderThreadId.make("provider-thread-1");
const instanceId = ProviderInstanceId.make("claudeAgent");
const worktree = "/repo/.houston/worktrees/c5";
const timestamp = "2026-11-03T12:00:00.000Z";

function scannedSession() {
  return {
    thread: {
      source: "claudeAgent" as const,
      providerInstanceId: instanceId,
      providerSessionId: "session-1",
      title: "Fix the login",
      model: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [{ role: "user" as const, text: "Fix the login flow", createdAt: timestamp }],
      omittedMessageCount: 0,
    },
    cwd: worktree,
    savedTitle: null,
    branch: "feature",
    runningExternally: true,
    source: {
      provider: "claudeAgent" as const,
      providerInstanceId: instanceId,
      providerSessionId: "session-1",
      filePath: "/home/me/.claude/projects/-repo-worktrees-c5/session-1.jsonl",
      size: 100,
      mtimeMs: 1,
      device: 1,
      inode: 1,
      birthtimeMs: 1,
    },
  };
}

function layerTest(input: {
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly worktreePath: string | null;
    readonly status: string;
    readonly activeProviderThreadId?: ProviderThreadId | null;
  }>;
  readonly providerThreads: ReadonlyArray<unknown>;
  readonly scanned?: ReturnType<typeof scannedSession>;
}) {
  return resumeSessionsLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({ id: projectId, workspaceRoot: "/repo", title: "Repo" } as never),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: () =>
            Effect.succeed({
              threads: input.threads,
              archivedThreads: [],
            } as never),
          listProviderThreadRefs: () => Effect.succeed(input.providerThreads as never),
        }),
        Layer.mock(AgentSessionScanner.AgentSessionScanner)({
          listRecentSessions: () =>
            Effect.succeed({
              sessions: input.scanned === undefined ? [] : [input.scanned],
              truncated: false,
            }),
        }),
        Layer.mock(AgentSessionImporter.AgentSessionImporter)({
          importAgentSession: () => Effect.succeed(threadId),
        }),
      ),
    ),
  );
}

const runList = (input: Parameters<typeof layerTest>[0]) =>
  Effect.gen(function* () {
    const service = yield* HoustonResumeSessions;
    return yield* service.list({ projectId });
  }).pipe(Effect.provide(layerTest(input)));

it.effect("maps a session whose provider thread belongs to a project thread", () =>
  Effect.gen(function* () {
    const result = yield* runList({
      threads: [
        {
          id: threadId,
          worktreePath: worktree,
          status: "running",
          activeProviderThreadId: providerThreadId,
        },
      ],
      providerThreads: [
        {
          id: providerThreadId,
          appThreadId: threadId,
          providerInstanceId: instanceId,
          driver: ProviderDriverKind.make("claudeAgent"),
          nativeThreadRef: { nativeId: "session-1" },
          status: "active",
        },
      ],
      scanned: scannedSession(),
    });
    expect(result.sessions[0]).toMatchObject({
      threadId,
      live: true,
      mayBeRunningElsewhere: false,
      branch: "feature",
      folder: worktree,
      providerSessionId: "session-1",
      firstPrompt: "Fix the login flow",
    });
  }),
);

it.effect("warns for an unowned session another CLI may hold", () =>
  Effect.gen(function* () {
    const result = yield* runList({
      threads: [],
      providerThreads: [],
      scanned: scannedSession(),
    });
    expect(result.sessions[0]).toMatchObject({
      threadId: null,
      live: false,
      mayBeRunningElsewhere: true,
    });
  }),
);

it.effect("opens a picked session through the importer with the project and worktree roots", () =>
  Effect.gen(function* () {
    let receivedRoots: ReadonlyArray<string> = [];
    const layer = resumeSessionsLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeedSome({ workspaceRoot: "/repo", title: "Repo" } as never),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getShellSnapshot: () =>
              Effect.succeed({
                threads: [{ id: threadId, worktreePath: worktree, status: "idle" }],
                archivedThreads: [],
              } as never),
            listProviderThreadRefs: () => Effect.succeed([]),
          }),
          Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
          Layer.mock(AgentSessionImporter.AgentSessionImporter)({
            importAgentSession: (input: { workspaceRoots: ReadonlyArray<string> }) => {
              receivedRoots = input.workspaceRoots;
              return Effect.succeed(threadId);
            },
          }),
        ),
      ),
    );
    const result = yield* Effect.gen(function* () {
      const service = yield* HoustonResumeSessions;
      return yield* service.open({ projectId, session: scannedSession().source });
    }).pipe(Effect.provide(layer));
    expect(result).toEqual({ threadId });
    expect(receivedRoots).toEqual(["/repo", worktree]);
  }),
);
