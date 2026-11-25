import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  type E2eeIdentityKeypair,
  encodeIdentityKey,
  identityFingerprint,
  identityPublicKeyFromSeed,
} from "@houston-app/shared/socketE2ee";
import { SecureRandom } from "effect/crypto";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const IDENTITY_SECRET_NAME = "e2ee-identity-seed-v1";

export class ServerE2eeIdentityError extends Schema.TaggedError<ServerE2eeIdentityError>()(
  "ServerE2eeIdentityError",
  { operation: Schema.Literals(["load", "rotate"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return this.operation === "rotate"
      ? "Could not rotate the server's E2EE identity key."
      : "Could not load the server's E2EE identity key.";
  }
}

export interface E2eeIdentityDescriptor {
  readonly publicKeyBase64Url: string;
  readonly fingerprint: string;
}

export class ServerE2eeIdentity extends Context.Service<
  ServerE2eeIdentity,
  {
    /** The 32-byte Ed25519 seed, loaded or created on first use. */
    readonly getKeypair: Effect.Effect<E2eeIdentityKeypair, ServerE2eeIdentityError>;
    readonly getDescriptor: Effect.Effect<E2eeIdentityDescriptor, ServerE2eeIdentityError>;
    /**
     * Replaces the identity key. Pinned clients fail their next handshake with
     * `E2EE_IDENTITY_MISMATCH` until they re-verify the new fingerprint.
     */
    readonly rotate: Effect.Effect<E2eeIdentityDescriptor, ServerE2eeIdentityError>;
  }
>()("@houston-app/cli/auth/ServerE2eeIdentity") {}

/** @public */
export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;

  const keypairFromSeed = (seed: Uint8Array): E2eeIdentityKeypair => ({
    seed,
    publicKey: identityPublicKeyFromSeed(seed),
  });

  const loadKeypair = Effect.map(secrets.getOrCreateRandom(IDENTITY_SECRET_NAME, 32), (stored) =>
    keypairFromSeed(Uint8Array.from(stored)),
  );

  const descriptorFromKeypair = (keypair: E2eeIdentityKeypair): E2eeIdentityDescriptor => ({
    publicKeyBase64Url: encodeIdentityKey(keypair.publicKey),
    fingerprint: identityFingerprint(keypair.publicKey),
  });

  const rotate = Effect.gen(function* () {
    const seed = Uint8Array.from(yield* random.randomBytes(32));
    const keypair = keypairFromSeed(seed);
    yield* secrets.set(IDENTITY_SECRET_NAME, keypair.seed);
    return descriptorFromKeypair(keypair);
  }).pipe(Effect.mapError((cause) => new ServerE2eeIdentityError({ operation: "rotate", cause })));

  return ServerE2eeIdentity.of({
    getKeypair: loadKeypair.pipe(
      Effect.mapError((cause) => new ServerE2eeIdentityError({ operation: "load", cause })),
    ),
    getDescriptor: Effect.map(
      loadKeypair.pipe(
        Effect.mapError((cause) => new ServerE2eeIdentityError({ operation: "load", cause })),
      ),
      descriptorFromKeypair,
    ),
    rotate,
  });
});

export const layer = Layer.effect(ServerE2eeIdentity, make);
