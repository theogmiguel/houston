import * as Effect from "effect/Effect";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";
import { FetchHttpClient, type HttpMethod } from "effect/http";

import type { PreparedConnection, PreparedHttpAuthorization } from "../connection/model.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiGroupClient,
  makeEnvironmentHttpApiUrlBuilder,
  RemoteEnvironmentAuthTimeoutError,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";

export interface EnvironmentHttpAuthHeaders {
  readonly authorization?: string;
}

export function withOrchestrationProtocolHeader(
  headers: EnvironmentHttpAuthHeaders,
): EnvironmentHttpAuthHeaders & {
  readonly [ORCHESTRATION_PROTOCOL_HEADER]: typeof ORCHESTRATION_PROTOCOL_VERSION_TEXT;
} {
  return {
    ...headers,
    [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  };
}

/**
 * Cookie-authenticated environments need credentialed mode for cross-origin fetches; bearer uses headers.
 * `FetchHttpClient` reads `RequestInit` from the fiber context per request.
 */
const withEnvironmentCredentials = <A, E, R>(
  authorization: PreparedHttpAuthorization | null,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  authorization === null
    ? request.pipe(Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }))
    : request;

function buildEnvironmentAuthHeaders(
  authorization: PreparedHttpAuthorization | null,
): EnvironmentHttpAuthHeaders {
  return authorization === null ? {} : { authorization: `Bearer ${authorization.token}` };
}

export const executeAuthenticatedEnvironmentHttpRequest = <
  Group extends Parameters<typeof makeEnvironmentHttpApiGroupClient>[1],
  A,
  E,
  R,
>(
  input: Parameters<typeof executeEnvironmentRequest<Group, A, E, R>>[0],
) => executeEnvironmentRequest(input).pipe(Effect.withSpan(ENVIRONMENT_REQUEST_SPAN));

const ENVIRONMENT_REQUEST_SPAN = "clientRuntime.state.executeAuthenticatedEnvironmentHttpRequest";

const executeEnvironmentRequest = Effect.fnUntraced(function* <
  Group extends Parameters<typeof makeEnvironmentHttpApiGroupClient>[1],
  A,
  E,
  R,
>(input: {
  readonly prepared: PreparedConnection;
  readonly method: HttpMethod.HttpMethod;
  /**
   * The URL to sign, from the group's contract URL builder. It encodes path
   * params exactly like the request client.
   */
  readonly url: (urls: ReturnType<typeof makeEnvironmentHttpApiUrlBuilder>[Group]) => string;
  readonly timeoutMs: number;
  readonly group: Group;
  readonly request: (input: {
    readonly client: Effect.Success<ReturnType<typeof makeEnvironmentHttpApiGroupClient<Group>>>;
    readonly headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<A, E, R>;
  /** Some endpoints report rejected credentials in a successful response. */
  readonly isUnauthorizedResponse?: (response: NoInfer<A>) => boolean;
}): Effect.fn.Return<
  A,
  RemoteEnvironmentRequestError,
  Effect.Services<ReturnType<typeof makeEnvironmentHttpApiGroupClient<Group>>> | R
> {
  const httpBaseUrl = input.prepared.httpBaseUrl;
  const requestUrlFor = (baseUrl: string) =>
    input.url(makeEnvironmentHttpApiUrlBuilder(baseUrl)[input.group]);
  return yield* Effect.gen(function* () {
    const authorization = input.prepared.httpAuthorization;
    const requestUrl = requestUrlFor(httpBaseUrl);
    const client = yield* makeEnvironmentHttpApiGroupClient(httpBaseUrl, input.group);
    const headers = buildEnvironmentAuthHeaders(authorization);
    return yield* executeEnvironmentHttpRequest(
      requestUrl,
      input.timeoutMs,
      withEnvironmentCredentials(authorization, input.request({ client, headers })),
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: input.timeoutMs,
      orElse: () =>
        Effect.fail(
          new RemoteEnvironmentAuthTimeoutError(requestUrlFor(httpBaseUrl), input.timeoutMs),
        ),
    }),
  );
});
