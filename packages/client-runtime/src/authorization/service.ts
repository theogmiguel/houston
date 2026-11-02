import {
  type ClientConnectionMethod,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { type RemoteEnvironmentAuthError, resolveRemoteWebSocketConnectionUrl } from "./remote.ts";
import { environmentMismatchError, mapRemoteEnvironmentError } from "../connection/errors.ts";
import type { ConnectionAttemptError } from "../connection/model.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";

export interface AuthorizedRemoteEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: { readonly _tag: "Bearer"; readonly token: string };
  readonly descriptor?: ExecutionEnvironmentDescriptor;
}

export class RemoteEnvironmentAuthorization extends Context.Service<
  RemoteEnvironmentAuthorization,
  {
    readonly authorizeBearer: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
=======
    readonly authorizeDpop: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      /**
       * The access token is not bound to an origin, and each proof is minted
       * for the URL it signs, so a token from the relay also works on the
       * environment's LAN or tailnet address.
       */
      readonly directEndpoint?: { readonly httpBaseUrl: string; readonly wsBaseUrl: string };
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    readonly authorizeDpopHttp: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly rejectedAccessToken?: string;
    }) => Effect.Effect<AuthorizedRemoteHttpEnvironment, ConnectionAttemptError>;
    /**
     * Renews a live socket's token before it expires, so the server moves the
     * socket to the new session instead of closing it. Runs until interrupted.
     */
    readonly renewDpopBeforeExpiry: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly expiresAtEpochMs: number;
    }) => Effect.Effect<void, ConnectionBlockedError>;
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb
  }
>()("@t3tools/client-runtime/authorization/service/RemoteEnvironmentAuthorization") {}

const fetchDescriptor = Effect.fn("clientRuntime.connection.remote.fetchDescriptor")(function* (
  httpBaseUrl: string,
) {
  return yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError((error) => mapRemoteEnvironmentError(error as RemoteEnvironmentAuthError)),
  );
});

export const make = Effect.gen(function* () {
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;

  /**
   * A saved LAN address can belong to another machine on a different network.
   */
  const verifyDirectEndpoint = Effect.fn("clientRuntime.connection.remote.verifyDirectEndpoint")(
    function* (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
    }) {
      const descriptor = yield* fetchDescriptor(input.httpBaseUrl).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      if (descriptor.environmentId !== input.expectedEnvironmentId) {
        return yield* environmentMismatchError({
          expected: input.expectedEnvironmentId,
          actual: descriptor.environmentId,
        });
      }
      return descriptor;
    },
  );

  const authorizeBearer = Effect.fn("clientRuntime.connection.remote.authorizeBearer")(
    function* (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
      readonly connectionMethod: ClientConnectionMethod;
    }) {
      const descriptor = yield* verifyDirectEndpoint(input);
      const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: input.wsBaseUrl,
        httpBaseUrl: input.httpBaseUrl,
        bearerToken: input.bearerToken,
        clientMetadata: presentation.metadata,
        connectionMethod: input.connectionMethod,
      }).pipe(
        Effect.mapError((error) => mapRemoteEnvironmentError(error as RemoteEnvironmentAuthError)),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl: input.httpBaseUrl,
        socketUrl,
        descriptor,
        httpAuthorization: {
          _tag: "Bearer" as const,
          token: input.bearerToken,
        },
      };
    },
  );

  return RemoteEnvironmentAuthorization.of({
    authorizeBearer,
<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
=======
    authorizeDpop: Effect.fn("environment.authorization")(function (input) {
      return authorizeDpop(input);
    }),
    // The relay tracer must wrap span creation, not just the token request.
    authorizeDpopHttp: Effect.fnUntraced(function* (input) {
      return yield* getDpopToken(input).pipe(
        Effect.map(({ token }) => httpAuthorization(token)),
        Effect.withSpan("environment.authorization.http"),
        withRelayClientTracing,
      );
    }),
    // Untraced: a span here would stay open for the socket's lifetime. Each renewal has its own.
    renewDpopBeforeExpiry: Effect.fnUntraced(function* (input) {
      let expiresAtEpochMs = input.expiresAtEpochMs;
      let now = yield* Clock.currentTimeMillis;
      // Past expiry the server has closed the socket.
      while (now < expiresAtEpochMs) {
        // getDpopToken reuses a cached token until it is within the skew of expiry.
        // The floor spaces out retries and keeps a wall-clock jump from spinning.
        yield* Effect.sleep(
          Math.max(5_000, expiresAtEpochMs - DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS - now),
        );
        const renewed = yield* getDpopToken({
          expectedEnvironmentId: input.expectedEnvironmentId,
        }).pipe(
          Effect.map(({ token }) => token.expiresAtEpochMs),
          Effect.withSpan("environment.authorization.renewSocket"),
          withRelayClientTracing,
          // A relay blip retries until expiry; a blocked credential ends the loop.
          Effect.catchTags({ ConnectionTransientError: () => Effect.succeed(expiresAtEpochMs) }),
        );
        expiresAtEpochMs = Math.max(expiresAtEpochMs, renewed);
        now = yield* Clock.currentTimeMillis;
      }
    }),
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb
  });
});

export const layer = Layer.effect(RemoteEnvironmentAuthorization, make);
