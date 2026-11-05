import { makeEnvironmentHttpApiClient } from "@houston-app/client-runtime/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolvePrimaryEnvironmentHttpUrl, type PrimaryEnvironmentTargetError } from "./target";

type PrimaryEnvironmentHttpApiClient = Effect.Success<
  ReturnType<typeof makeEnvironmentHttpApiClient>
>;

export interface PrimaryEnvironmentHttpClient {
  readonly PrimaryEnvironmentHttpClient: unique symbol;
}

export const PrimaryEnvironmentHttpClient: Context.Service<
  PrimaryEnvironmentHttpClient,
  PrimaryEnvironmentHttpApiClient
> = Context.Service(
  "@houston-app/web/environments/primary/httpClient/PrimaryEnvironmentHttpClient",
);

const make = Effect.try({
  try: () => resolvePrimaryEnvironmentHttpUrl("/"),
  catch: (cause) => cause as PrimaryEnvironmentTargetError,
}).pipe(Effect.flatMap(makeEnvironmentHttpApiClient));

/** Resolves the server address when built; build it per request, as the address can change. */
export const layer = Layer.effect(PrimaryEnvironmentHttpClient, make);
