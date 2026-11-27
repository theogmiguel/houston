import {
  type HoustonMcpSignInCompleteInput,
  type HoustonMcpSignInCompleteResult,
  HoustonMcpSignInError,
  type HoustonMcpSignInStartInput,
  type HoustonMcpSignInStartResult,
  type ProviderThreadId,
  type ThreadId,
} from "@houston-app/contracts";
import type * as ProviderAdapter from "@houston-app/provider-core/server/ProviderAdapter";
import { requireMcpSignIn } from "@houston-app/provider-core/server/houston/mcpSignIn";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/**
 * Routes an MCP sign-in to the thread's live provider session. It never starts one: an ended or
 * never-started session is refused so a notice cannot spend a provider run.
 */
export class McpSignIn extends Context.Service<
  McpSignIn,
  {
    readonly start: (
      input: HoustonMcpSignInStartInput,
    ) => Effect.Effect<HoustonMcpSignInStartResult, HoustonMcpSignInError>;
    readonly complete: (
      input: HoustonMcpSignInCompleteInput,
    ) => Effect.Effect<HoustonMcpSignInCompleteResult, HoustonMcpSignInError>;
  }
>()("@houston-app/cli/houston/mcpSignIn") {}

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  const failed = (threadId: string, server: string, message: string) =>
    new HoustonMcpSignInError({ kind: "failed", server, message });
  const sessionEnded = (threadId: string, server: string, state: string) =>
    new HoustonMcpSignInError({
      kind: "session-ended",
      server,
      message: `Thread ${threadId}'s provider session has ${state}, so ${server} cannot be signed in from here.`,
    });

  const adapterFailure =
    (threadId: string, server: string) =>
    (cause: HoustonMcpSignInError | ProviderAdapter.ProviderAdapterV2Error) =>
      cause._tag === "HoustonMcpSignInError"
        ? cause
        : failed(threadId, server, `Thread ${threadId}'s provider failed to sign in ${server}.`);

  const resolve = Effect.fn("McpSignIn.resolve")(function* (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly server: string;
  }) {
    const records = yield* threadManagement
      .getThreadRecords(input.threadId, ["providerThreads"])
      .pipe(
        Effect.mapError(() =>
          failed(
            input.threadId,
            input.server,
            `Couldn't read thread ${input.threadId} to sign in ${input.server}.`,
          ),
        ),
      );
    const providerThread = records.providerThreads.find(
      (candidate) => candidate.id === input.providerThreadId,
    );
    if (providerThread === undefined) {
      return yield* failed(
        input.threadId,
        input.server,
        `Provider thread ${input.providerThreadId} does not belong to thread ${input.threadId}.`,
      );
    }
    if (providerThread.providerSessionId == null) {
      return yield* sessionEnded(input.threadId, input.server, "never started");
    }
    const runtime = Option.getOrUndefined(
      yield* providerSessions
        .get(providerThread.providerSessionId)
        .pipe(
          Effect.mapError(() =>
            failed(
              input.threadId,
              input.server,
              `Couldn't read thread ${input.threadId}'s provider session to sign in ${input.server}.`,
            ),
          ),
        ),
    );
    if (runtime === undefined) {
      return yield* sessionEnded(input.threadId, input.server, "ended");
    }
    const mcpSignIn = yield* requireMcpSignIn(runtime, {
      driver: runtime.driver,
      server: input.server,
    });
    return { providerThread, mcpSignIn };
  });

  const start = Effect.fn("McpSignIn.start")(function* (input: HoustonMcpSignInStartInput) {
    const resolved = yield* resolve(input);
    const started = yield* resolved.mcpSignIn
      .start({ providerThread: resolved.providerThread, server: input.server })
      .pipe(Effect.mapError(adapterFailure(input.threadId, input.server)));
    return {
      authorizationUrl: started.authorizationUrl,
      signedInAt:
        started.authorizationUrl === null ? DateTime.formatIso(yield* DateTime.now) : null,
    } satisfies HoustonMcpSignInStartResult;
  });

  const complete = Effect.fn("McpSignIn.complete")(function* (
    input: HoustonMcpSignInCompleteInput,
  ) {
    const resolved = yield* resolve(input);
    yield* resolved.mcpSignIn
      .complete({
        providerThread: resolved.providerThread,
        server: input.server,
        callbackUrl: input.callbackUrl,
      })
      .pipe(Effect.mapError(adapterFailure(input.threadId, input.server)));
    return {
      signedInAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies HoustonMcpSignInCompleteResult;
  });

  return McpSignIn.of({ start, complete });
});

export const layer = Layer.effect(McpSignIn, make);
