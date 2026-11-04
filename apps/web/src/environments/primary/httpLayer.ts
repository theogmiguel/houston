import { layerRemoteHttpClient } from "@houston-app/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http";

import { invalidateDesktopPrimaryBearerToken, readDesktopPrimaryBearerToken } from "./desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "./target";

function isSameOriginBrowserPrimary(): boolean {
  if (
    typeof window === "undefined" ||
    window.hostBridge !== undefined ||
    !window.location.origin.startsWith("http")
  ) {
    return false;
  }

  return new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin === window.location.origin;
}

function withPrimaryBearerToken(client: HttpClient.HttpClient): HttpClient.HttpClient {
  return client.pipe(
    HttpClient.mapRequestEffect((request) =>
      Effect.tryPromise({
        try: readDesktopPrimaryBearerToken,
        // The host fails here while its server is still starting; a transport failure lets callers retry.
        catch: (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause,
              // The cause already reads "The desktop host could not provide a credential ...".
              description: cause instanceof Error ? cause.message : String(cause),
            }),
          }),
      }).pipe(
        Effect.map((bearerToken) =>
          bearerToken ? HttpClientRequest.bearerToken(request, bearerToken) : request,
        ),
      ),
    ),
  );
}

export function layerForCurrentOrigin() {
  return Layer.unwrap(
    Effect.sync(() => {
      const layerBase = layerRemoteHttpClient(globalThis.fetch);
      if (isSameOriginBrowserPrimary()) {
        return Layer.merge(
          layerBase,
          Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }),
        );
      }

      // A rejected cached bearer would otherwise fail every request until relaunch.
      const withUnauthorizedInvalidation = (client: HttpClient.HttpClient) =>
        client.pipe(
          HttpClient.transformResponse((effect) =>
            Effect.tap(effect, (response) =>
              response.status === 401
                ? Effect.sync(() => invalidateDesktopPrimaryBearerToken())
                : Effect.void,
            ),
          ),
        );
      const layerBearerClient = Layer.effect(
        HttpClient.HttpClient,
        Effect.map(HttpClient.HttpClient, (client) =>
          withUnauthorizedInvalidation(withPrimaryBearerToken(client)),
        ),
      ).pipe(Layer.provide(layerBase));

      return Layer.merge(
        layerBearerClient,
        Layer.succeed(FetchHttpClient.RequestInit, { credentials: "omit" }),
      );
    }),
  );
}

export const layer = layerForCurrentOrigin();
