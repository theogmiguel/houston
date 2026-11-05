import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";

import { layerRemoteHttpClient } from "@houston-app/client-runtime/rpc";
import * as PrimaryEnvironmentHttpClient from "../environments/primary/httpClient";
import * as PrimaryEnvironmentHttpLayer from "../environments/primary/httpLayer";

import * as ClientTracer from "../observability/clientTracer";

const layerHttpClient = layerRemoteHttpClient((input, init) => globalThis.fetch(input, init));

const layerSecureRandom = Layer.succeed(
  SecureRandom.SecureRandom,
  SecureRandom.make((size) => crypto.getRandomValues(new Uint8Array(size))),
);

const digestEffect = Effect.fn("Digest.Digest.digest")(
  (algorithm: Digest.Algorithm, data: Uint8Array) =>
    Effect.promise(async () => {
      const bytes = new Uint8Array(data.byteLength);
      bytes.set(data);
      return new Uint8Array(await crypto.subtle.digest(algorithm.name, bytes));
    }),
);

const layerDigest = Layer.succeed(
  Digest.Digest,
  Digest.Digest.of({
    digest: digestEffect,
    digestHex: Effect.fn("Digest.Digest.digestHex")(
      (algorithm: Digest.Algorithm, data: Uint8Array) =>
        Effect.flatMap(digestEffect(algorithm, data), (bytes) =>
          Effect.succeed(Buffer.from(bytes).toString("hex")),
        ),
    ),
  }),
);

type RuntimeLayerSource =
  | typeof layerHttpClient
  | typeof layerSecureRandom
  | typeof layerDigest
  | typeof Socket.layerWebSocketConstructorGlobal
  | typeof ClientTracer.layer;

const primaryHttpRuntime = ManagedRuntime.make(PrimaryEnvironmentHttpLayer.layer);

export type PrimaryHttpEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, PrimaryEnvironmentHttpClient.PrimaryEnvironmentHttpClient>,
) => Promise<A>;

// The API client is built per request: one built before the desktop server published its
// address would keep the wrong one for the page's lifetime.
const livePrimaryHttpRunner: PrimaryHttpEffectRunner = (effect) =>
  primaryHttpRuntime.runPromise(Effect.provide(effect, PrimaryEnvironmentHttpClient.layer));

let primaryHttpRunner = livePrimaryHttpRunner;

export const runPrimaryHttp = <A, E>(
  effect: Effect.Effect<A, E, PrimaryEnvironmentHttpClient.PrimaryEnvironmentHttpClient>,
) => primaryHttpRunner(effect);

export function __setPrimaryHttpRunnerForTests(runner?: PrimaryHttpEffectRunner): void {
  primaryHttpRunner = runner ?? livePrimaryHttpRunner;
}

const layerRuntime = Layer.mergeAll(
  layerHttpClient,
  layerSecureRandom,
  layerDigest,
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
