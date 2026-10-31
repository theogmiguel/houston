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
  });
});

export const layer = Layer.effect(RemoteEnvironmentAuthorization, make);
