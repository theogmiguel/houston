import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";

import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import * as PrimaryEnvironmentHttpClient from "../environments/primary/httpClient";
import * as PrimaryEnvironmentHttpLayer from "../environments/primary/httpLayer";

import * as ClientTracer from "../observability/clientTracer";

const layerHttpClient = layerRemoteHttpClient((input, init) => globalThis.fetch(input, init));

const layerCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const bytes = new Uint8Array(data.byteLength);
        bytes.set(data);
        return new Uint8Array(await crypto.subtle.digest(algorithm, bytes));
      }),
  }),
);

type RuntimeLayerSource =
  | typeof layerHttpClient
  | typeof layerCrypto
  | typeof Socket.layerWebSocketConstructorGlobal
  | typeof ClientTracer.layer;

const primaryHttpRuntime = ManagedRuntime.make(
  PrimaryEnvironmentHttpClient.layer.pipe(Layer.provide(PrimaryEnvironmentHttpLayer.layer)),
);

export type PrimaryHttpEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, PrimaryEnvironmentHttpClient.PrimaryEnvironmentHttpClient>,
) => Promise<A>;

const livePrimaryHttpRunner: PrimaryHttpEffectRunner = (effect) =>
  primaryHttpRuntime.runPromise(effect);

let primaryHttpRunner = livePrimaryHttpRunner;

export const runPrimaryHttp = <A, E>(
  effect: Effect.Effect<A, E, PrimaryEnvironmentHttpClient.PrimaryEnvironmentHttpClient>,
) => primaryHttpRunner(effect);

export function __setPrimaryHttpRunnerForTests(runner?: PrimaryHttpEffectRunner): void {
  primaryHttpRunner = runner ?? livePrimaryHttpRunner;
}

const layerRuntime = Layer.mergeAll(
  layerHttpClient,
  layerCrypto,
  Socket.layerWebSocketConstructorGlobal,
  ClientTracer.layer,
);

export const runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = ManagedRuntime.make(layerRuntime);

export const layer: Layer.Layer<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = Layer.effectContext(runtime.contextEffect);
