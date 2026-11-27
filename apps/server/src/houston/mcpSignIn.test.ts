import {
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type HoustonMcpSignInStartInput,
} from "@houston-app/contracts";
import { assert, describe, it } from "@effect/vitest";
import type * as ProviderAdapter from "@houston-app/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as McpSignIn from "./mcpSignIn.ts";

const threadId = ThreadId.make("thread-mcp-sign-in");
const providerThreadId = ProviderThreadId.make("provider-thread-mcp-sign-in");
const providerSessionId = ProviderSessionId.make("provider-session-mcp-sign-in");
const input: HoustonMcpSignInStartInput = { threadId, providerThreadId, server: "notion" };
const callbackUrl = "http://127.0.0.1:1/callback?code=a&state=b";

function makeLayer(options: {
  readonly sessionId?: ProviderSessionId | null;
  readonly runtime?: Option.Option<ProviderAdapter.ProviderAdapterV2SessionRuntime>;
}) {
  const sessionId = options.sessionId === undefined ? providerSessionId : options.sessionId;
  return McpSignIn.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { lineage: { parentThreadId: null, rootThreadId: threadId } },
              providerThreads: [{ id: providerThreadId, providerSessionId: sessionId }],
            } as never),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: () => Effect.succeed(options.runtime ?? Option.none()),
        }),
      ),
    ),
  );
}

const runtime = (capability?: ProviderAdapter.ProviderAdapterV2McpSignIn) =>
  Option.some({
    driver: ProviderDriverKind.make("codex"),
    ...(capability === undefined ? {} : { mcpSignIn: capability }),
  } as ProviderAdapter.ProviderAdapterV2SessionRuntime);

describe("McpSignIn", () => {
  it.effect("routes start and complete to the thread's live session", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const layer = makeLayer({
        runtime: runtime({
          start: ({ server }) =>
            Effect.sync(() => {
              calls.push(["start", server]);
              return { authorizationUrl: "https://auth.example.com/authorize" };
            }),
          complete: ({ server, callbackUrl }) =>
            Effect.sync(() => {
              calls.push(["complete", server, callbackUrl]);
            }),
        }),
      });
      yield* Effect.gen(function* () {
        const signIn = yield* McpSignIn.McpSignIn;
        const started = yield* signIn.start(input);
        assert.equal(started.authorizationUrl, "https://auth.example.com/authorize");
        assert.isNull(started.signedInAt);
        const completed = yield* signIn.complete({ ...input, callbackUrl });
        assert.match(completed.signedInAt, /^\d{4}-\d{2}-\d{2}T/u);
        assert.deepEqual(calls, [
          ["start", "notion"],
          ["complete", "notion", callbackUrl],
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("reports an already signed-in server with a timestamp and no page", () =>
    Effect.gen(function* () {
      const layer = makeLayer({
        runtime: runtime({
          start: () => Effect.succeed({ authorizationUrl: null }),
          complete: () => Effect.void,
        }),
      });
      yield* Effect.gen(function* () {
        const signIn = yield* McpSignIn.McpSignIn;
        const started = yield* signIn.start(input);
        assert.isNull(started.authorizationUrl);
        assert.isString(started.signedInAt);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("refuses an ended session, naming the thread and its state", () =>
    Effect.gen(function* () {
      const layer = makeLayer({ runtime: Option.none() });
      yield* Effect.gen(function* () {
        const signIn = yield* McpSignIn.McpSignIn;
        const error = yield* signIn.start(input).pipe(Effect.flip);
        assert.equal(error.kind, "session-ended");
        assert.include(error.message, String(threadId));
        assert.include(error.message, "ended");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("refuses a thread that never started a session, naming its state", () =>
    Effect.gen(function* () {
      const layer = makeLayer({ sessionId: null });
      yield* Effect.gen(function* () {
        const signIn = yield* McpSignIn.McpSignIn;
        const error = yield* signIn.complete({ ...input, callbackUrl }).pipe(Effect.flip);
        assert.equal(error.kind, "session-ended");
        assert.include(error.message, String(threadId));
        assert.include(error.message, "never started");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("refuses a provider without sign-in support by name", () =>
    Effect.gen(function* () {
      const layer = makeLayer({ runtime: runtime() });
      yield* Effect.gen(function* () {
        const signIn = yield* McpSignIn.McpSignIn;
        const error = yield* signIn.start(input).pipe(Effect.flip);
        assert.equal(error.kind, "unsupported-provider");
        assert.include(error.message, "codex");
        assert.include(error.message, "notion");
      }).pipe(Effect.provide(layer));
    }),
  );
});
