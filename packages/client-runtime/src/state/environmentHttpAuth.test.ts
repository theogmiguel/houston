import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  type AuthSessionState,
  type OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadTranscript,
  type OrchestrationV2ThreadHistoryPage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { HttpClient } from "effect/http";

import {
  BearerConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { type RemoteEnvironmentRequestError } from "../rpc/http.ts";
import * as RpcHttp from "../rpc/http.ts";
import * as PullRequestDiffLoader from "./pullRequestDiffHttp.ts";
import { fetchEnvironmentSessionState } from "./session.ts";
import { fetchEnvironmentShellSnapshot } from "./shellSnapshotHttp.ts";
import { fetchEnvironmentThreadTranscript } from "./threadTranscriptHttp.ts";
import { fetchEnvironmentBoundedThreadSnapshot } from "./boundedThreadSnapshotHttp.ts";
import { fetchEnvironmentThreadHistoryPage } from "./threadHistoryHttp.ts";
import { v2Projection } from "./orchestrationV2TestFixtures.ts";

const encodeBoundedSnapshot = Schema.encodeSync(OrchestrationV2ThreadBoundedSnapshot);
const encodeThreadTranscript = Schema.encodeSync(OrchestrationV2ThreadTranscript);

const TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  connectionId: "bearer-1",
});
const ORIGIN = "https://current.example.test";
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: ORIGIN,
  socketUrl: "wss://current.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "bearer-token" },
  target: TARGET,
};
const DIFF = {
  projectId: ProjectId.make("project-1"),
  repository: "owner/repository",
  number: 42,
};
const DIFF_RESULT = { patch: "diff --git a/file.ts b/file.ts", truncated: false, nextCursor: null };
const AUTH = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "t3_session",
} satisfies AuthSessionState["auth"];
const SESSION = {
  authenticated: true,
  auth: AUTH,
  scopes: ["orchestration:read", "orchestration:operate"],
  sessionMethod: "bearer-access-token",
} satisfies AuthSessionState;
const SHELL = {
  schemaVersion: 1,
  snapshotSequence: 1,
  projects: [],
  threads: [],
  archivedThreads: [],
} satisfies OrchestrationV2ShellSnapshot;
const THREAD = {
  snapshotSequence: 2,
  projection: v2Projection,
} satisfies OrchestrationV2ThreadDetailSnapshot;
const TRANSCRIPT = {
  threadId: v2Projection.thread.id,
  title: v2Projection.thread.title,
  updatedAt: v2Projection.updatedAt,
  items: v2Projection.visibleTurnItems,
} satisfies OrchestrationV2ThreadTranscript;
const BOUNDED_THREAD = {
  ...THREAD,
  historyCursor: "older-page",
  hasMoreHistory: true,
  latestLocalTurnOrdinal: 3,
} satisfies OrchestrationV2ThreadBoundedSnapshot;
const THREAD_HISTORY = {
  snapshotSequence: 2,
  items: [],
  nextCursor: null,
  hasMoreHistory: false,
} satisfies OrchestrationV2ThreadHistoryPage;

function makeHarness(reply: (requestNumber: number) => Response | Promise<Response>) {
  const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  const fetchFn: typeof fetch = async (request, init) => {
    calls.push({ url: String(request), init: init ?? {} });
    return reply(calls.length);
  };
  return {
    calls,
    input: { prepared: PREPARED },
    httpLayer: RpcHttp.layerRemoteHttpClient(fetchFn),
  };
}

type HttpInput = ReturnType<typeof makeHarness>["input"];
const LOADERS: ReadonlyArray<{
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly response: unknown;
  readonly expected: unknown;
  readonly load: (
    input: HttpInput,
  ) => Effect.Effect<
    unknown,
    RemoteEnvironmentRequestError | PullRequestDiffLoader.PullRequestDiffCredentialRejectedError,
    HttpClient.HttpClient
  >;
}> = [
  {
    name: "PR diff",
    method: "POST",
    path: "/api/pull-requests/diff",
    response: DIFF_RESULT,
    expected: DIFF_RESULT,
    load: (input: HttpInput) =>
      PullRequestDiffLoader.fetchEnvironmentPullRequestDiff({ ...input, diff: DIFF }),
  },
  {
    name: "session permissions",
    method: "GET",
    path: "/api/auth/session",
    response: SESSION,
    expected: SESSION,
    load: fetchEnvironmentSessionState,
  },
  {
    name: "shell snapshot",
    method: "GET",
    path: "/api/orchestration/shell",
    response: SHELL,
    expected: SHELL,
    load: (input: HttpInput) =>
      fetchEnvironmentShellSnapshot(input).pipe(
        Effect.map(({ loadPullRequests: _links, ...snapshot }) => snapshot),
      ),
  },
  {
    name: "thread transcript",
    method: "GET",
    path: `/api/orchestration/threads/${TRANSCRIPT.threadId}/transcript`,
    response: encodeThreadTranscript(TRANSCRIPT),
    expected: TRANSCRIPT,
    load: (input: HttpInput) =>
      fetchEnvironmentThreadTranscript({ ...input, threadId: TRANSCRIPT.threadId }),
  },
  {
    name: "bounded thread snapshot",
    method: "GET",
    path: `/api/orchestration/threads/${THREAD.projection.thread.id}/bounded`,
    response: encodeBoundedSnapshot(BOUNDED_THREAD),
    expected: BOUNDED_THREAD,
    load: (input: HttpInput) =>
      fetchEnvironmentBoundedThreadSnapshot({ ...input, threadId: THREAD.projection.thread.id }),
  },
  {
    name: "older thread history",
    method: "GET",
    path: `/api/orchestration/threads/${THREAD.projection.thread.id}/history`,
    response: THREAD_HISTORY,
    expected: THREAD_HISTORY,
    load: (input: HttpInput) =>
      fetchEnvironmentThreadHistoryPage({
        ...input,
        threadId: THREAD.projection.thread.id,
        cursor: "older-page",
      }),
  },
];

describe("authenticated environment HTTP requests", () => {
  it.effect.each(LOADERS)("rejects an invalid $name response", (loader) =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json({}));
      const result = yield* loader
        .load(harness.input)
        .pipe(Effect.provide(harness.httpLayer), Effect.asVoid, Effect.flip);
      expect(result._tag).toBe("RemoteEnvironmentAuthInvalidJsonError");
      expect(harness.calls).toHaveLength(1);
    }),
  );

  it.effect("keeps the status of a shell snapshot error that is not a declared error", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json({ error: "bad_gateway" }, { status: 502 }));
      const error = yield* fetchEnvironmentShellSnapshot(harness.input).pipe(
        Effect.provide(harness.httpLayer),
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: "RemoteEnvironmentAuthUndeclaredStatusError",
        status: 502,
      });
    }),
  );

  it.effect.each(LOADERS)("sends the prepared bearer token to $name", (loader) =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json(loader.response));
      const result = yield* loader.load(harness.input).pipe(Effect.provide(harness.httpLayer));

      expect(result).toEqual(loader.expected);
      expect(harness.calls).toHaveLength(1);
      const call = harness.calls[0]!;
      const url = new URL(call.url);
      expect(url.origin).toBe(ORIGIN);
      expect(url.pathname).toBe(loader.path);
      expect(call.init.method).toBe(loader.method);
      expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer bearer-token");
      expect(call.init.credentials).toBeUndefined();
    }),
  );
});
