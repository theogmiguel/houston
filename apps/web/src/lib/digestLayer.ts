import { sha256 } from "@noble/hashes/sha2";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// Browsers expose crypto.subtle only in secure contexts, so a page served over
// plain HTTP (a LAN or Tailscale address) has to hash in JavaScript.
const FALLBACK_ALGORITHMS: Partial<
  Record<Digest.Algorithm["name"], (data: Uint8Array) => Uint8Array>
> = {
  "SHA-256": sha256,
};

const digestBytes = async (algorithm: Digest.Algorithm, data: Uint8Array): Promise<Uint8Array> => {
  if (algorithm.implementation) return algorithm.implementation(data);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const bytes = new Uint8Array(data.byteLength);
    bytes.set(data);
    return new Uint8Array(await subtle.digest(algorithm.name, bytes));
  }
  const fallback = FALLBACK_ALGORITHMS[algorithm.name];
  if (!fallback) {
    throw new Error(
      `Digest algorithm ${JSON.stringify(algorithm.name)} is unavailable without crypto.subtle; supported without it: ${Object.keys(FALLBACK_ALGORITHMS).join(", ")}`,
    );
  }
  return fallback(data);
};

const digestEffect = Effect.fn("Digest.Digest.digest")(
  (algorithm: Digest.Algorithm, data: Uint8Array) =>
    Effect.promise(() => digestBytes(algorithm, data)),
);

export const layerDigest = Layer.succeed(
  Digest.Digest,
  Digest.Digest.of({
    digest: digestEffect,
    digestHex: Effect.fn("Digest.Digest.digestHex")(
      (algorithm: Digest.Algorithm, data: Uint8Array) =>
        Effect.map(digestEffect(algorithm, data), (bytes) => Buffer.from(bytes).toString("hex")),
    ),
  }),
);
