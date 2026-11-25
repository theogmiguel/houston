import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerE2eeIdentity from "./ServerE2eeIdentity.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

/** An in-memory secret store; the identity never touches the host's real secrets. */
const makeSecretStore = () => {
  const stored = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
    set: (name, value) => Effect.sync(() => void stored.set(name, value)),
    create: (name, value) => Effect.sync(() => void stored.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = stored.get(name);
        if (existing !== undefined) return existing;
        const value = new Uint8Array(bytes).fill(7);
        stored.set(name, value);
        return value;
      }),
    remove: (name) => Effect.sync(() => void stored.delete(name)),
  });
};

const layerIdentity = Layer.effect(
  ServerE2eeIdentity.ServerE2eeIdentity,
  ServerE2eeIdentity.make,
).pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(ServerSecretStore.ServerSecretStore, makeSecretStore()),
      NodeCrypto.layer,
    ),
  ),
);

describe("ServerE2eeIdentity", () => {
  it.effect("creates one identity and keeps it stable", () =>
    Effect.gen(function* () {
      const identity = yield* ServerE2eeIdentity.ServerE2eeIdentity;
      const first = yield* identity.getDescriptor;
      const second = yield* identity.getDescriptor;
      assert.equal(first.publicKeyBase64Url, second.publicKeyBase64Url);
      assert.equal(first.fingerprint, second.fingerprint);
      assert.match(first.fingerprint, /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
      assert.equal((yield* identity.getKeypair).seed.length, 32);
    }).pipe(Effect.provide(layerIdentity)),
  );

  it.effect("rotating replaces the key and fingerprint", () =>
    Effect.gen(function* () {
      const identity = yield* ServerE2eeIdentity.ServerE2eeIdentity;
      const before = yield* identity.getDescriptor;
      const rotated = yield* identity.rotate;
      assert.notEqual(rotated.publicKeyBase64Url, before.publicKeyBase64Url);
      assert.notEqual(rotated.fingerprint, before.fingerprint);
      const after = yield* identity.getDescriptor;
      assert.equal(after.publicKeyBase64Url, rotated.publicKeyBase64Url);
    }).pipe(Effect.provide(layerIdentity)),
  );
});
