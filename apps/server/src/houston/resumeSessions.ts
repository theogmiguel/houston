import type { ProviderThreadId, ThreadId } from "@houston-app/contracts";
import {
  type HoustonOpenResumeSessionInput,
  type HoustonOpenResumeSessionResult,
  HoustonResumeSessionError,
  type HoustonResumeSession,
  type HoustonResumeSessionsInput,
  type HoustonResumeSessionsResult,
} from "@houston-app/contracts/houston/resumeSessions";
import { normalizeProjectPathForComparison } from "@houston-app/shared/path";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as ProjectService from "../project/ProjectService.ts";

interface OwnedSession {
  readonly threadId: ThreadId;
  readonly live: boolean;
}

type ProjectThreads = ReadonlyArray<{
  readonly id: ThreadId;
  readonly worktreePath: string | null;
  readonly status: string;
  readonly activeProviderThreadId: ProviderThreadId | null;
}>;

const LIVE_THREAD_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

const projectRoots = (workspaceRoot: string, threads: ProjectThreads): ReadonlyArray<string> => {
  const roots = [workspaceRoot];
  const seen = new Set([normalizeProjectPathForComparison(workspaceRoot)]);
  for (const thread of threads) {
    if (thread.worktreePath === null) continue;
    const normalized = normalizeProjectPathForComparison(thread.worktreePath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    roots.push(thread.worktreePath);
  }
  return roots;
};

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const importer = yield* AgentSessionImporter.AgentSessionImporter;

  const resolveProject = (projectId: HoustonResumeSessionsInput["projectId"]) =>
    projects.getById(projectId).pipe(
      Effect.mapError(
        (cause) =>
          new HoustonResumeSessionError({
            reason: "project-not-found",
            projectId,
            providerSessionId: null,
            searchedRoots: 0,
            cause,
          }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new HoustonResumeSessionError({
                reason: "project-not-found",
                projectId,
                providerSessionId: null,
                searchedRoots: 0,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const readProjectThreads = (projectId: HoustonResumeSessionsInput["projectId"]) =>
    projections.getShellSnapshot({ projectId }).pipe(
      Effect.map((snapshot): ProjectThreads => [...snapshot.threads, ...snapshot.archivedThreads]),
      // Worktree and ownership discovery are extras; the project root still lists without them.
      Effect.orElseSucceed((): ProjectThreads => []),
    );

  /** A provider session belongs to the app thread whose provider thread names it. */
  const ownedSessions = Effect.fn("HoustonResumeSessions.ownedSessions")(
    function* (threads: ProjectThreads) {
      const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
      const refs = yield* projections.listProviderThreadRefs(threads.map((thread) => thread.id));
      const owned = new Map<string, OwnedSession>();
      for (const ref of refs) {
        if (ref.appThreadId === null || ref.nativeThreadRef === null) continue;
        const thread = threadsById.get(ref.appThreadId);
        // A thread's older provider sessions are history; only the active one is openable.
        if (thread === undefined || thread.activeProviderThreadId !== ref.id) continue;
        const key = `${ref.providerInstanceId}\u0000${ref.nativeThreadRef.nativeId}`;
        const live = LIVE_THREAD_STATUSES.has(thread.status);
        const current = owned.get(key);
        if (current === undefined || (!current.live && live)) {
          owned.set(key, { threadId: ref.appThreadId, live });
        }
      }
      return owned;
    },
    Effect.orElseSucceed((): ReadonlyMap<string, OwnedSession> => new Map()),
  );

  const list = Effect.fn("HoustonResumeSessions.list")(function* (
    input: HoustonResumeSessionsInput,
  ): Effect.fn.Return<HoustonResumeSessionsResult, HoustonResumeSessionError> {
    const project = yield* resolveProject(input.projectId);
    const threads = yield* readProjectThreads(input.projectId);
    const roots = projectRoots(project.workspaceRoot, threads);
    const owned = yield* ownedSessions(threads);
    const scanned = yield* scanner.listRecentSessions(roots).pipe(
      Effect.mapError(
        (cause) =>
          new HoustonResumeSessionError({
            reason: "scan-failed",
            projectId: input.projectId,
            providerSessionId: null,
            searchedRoots: roots.length,
            cause,
          }),
      ),
    );
    const sessions: Array<HoustonResumeSession> = scanned.sessions.map((session) => {
      const key = `${session.thread.providerInstanceId}\u0000${session.thread.providerSessionId}`;
      const owner = owned.get(key);
      const threadId = owner?.threadId ?? null;
      return {
        session: session.source,
        provider: session.thread.source,
        providerInstanceId: session.thread.providerInstanceId,
        providerSessionId: session.thread.providerSessionId,
        title: session.savedTitle,
        firstPrompt:
          session.thread.messages.find((message) => message.role === "user")?.text ?? null,
        folder: session.cwd,
        branch: session.branch,
        lastActiveAt: session.thread.updatedAt,
        threadId,
        live: threadId !== null && owner !== undefined && owner.live,
        mayBeRunningElsewhere: threadId === null && session.runningExternally,
      };
    });
    return {
      sessions,
      scannedAt: DateTime.formatIso(yield* DateTime.now),
      ...(scanned.truncated ? { truncated: true } : {}),
    };
  });

  const open = Effect.fn("HoustonResumeSessions.open")(function* (
    input: HoustonOpenResumeSessionInput,
  ): Effect.fn.Return<HoustonOpenResumeSessionResult, HoustonResumeSessionError> {
    const project = yield* resolveProject(input.projectId);
    const threads = yield* readProjectThreads(input.projectId);
    const roots = projectRoots(project.workspaceRoot, threads);
    const threadId = yield* importer
      .importAgentSession({
        projectId: input.projectId,
        source: input.session,
        workspaceRoots: roots,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new HoustonResumeSessionError({
              reason: "session-not-found",
              projectId: input.projectId,
              providerSessionId: input.session.providerSessionId,
              searchedRoots: roots.length,
              cause,
            }),
        ),
      );
    if (threadId === null) {
      return yield* new HoustonResumeSessionError({
        reason: "session-not-found",
        projectId: input.projectId,
        providerSessionId: input.session.providerSessionId,
        searchedRoots: roots.length,
      });
    }
    return { threadId };
  });

  return { list, open };
});

export class HoustonResumeSessions extends Context.Service<
  HoustonResumeSessions,
  {
    readonly list: (
      input: HoustonResumeSessionsInput,
    ) => Effect.Effect<HoustonResumeSessionsResult, HoustonResumeSessionError>;
    readonly open: (
      input: HoustonOpenResumeSessionInput,
    ) => Effect.Effect<HoustonOpenResumeSessionResult, HoustonResumeSessionError>;
  }
>()("@houston-app/cli/houston/resumeSessions/HoustonResumeSessions") {}

export const layer = Layer.effect(HoustonResumeSessions, make);
