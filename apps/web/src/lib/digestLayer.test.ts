import { describe, expect, it } from "@effect/vitest";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { layerDigest } from "./digestLayer";

const ABC = new TextEncoder().encode("abc");
const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const SHA256_448_BITS = "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1";
const MD5_ABC = "900150983cd24fb0d6963f7d28e17f72";

const hex = (algorithm: Digest.Algorithm, data: Uint8Array) =>
  Effect.gen(function* () {
    const digest = yield* Digest.Digest;
    return yield* digest.digestHex(algorithm, data);
  });

const withoutSubtle = <A, E>(effect: Effect.Effect<A, E, Digest.Digest>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => vi.stubGlobal("crypto", {})),
    () => effect,
    () => Effect.sync(() => vi.unstubAllGlobals()),
  ).pipe(Effect.provide(layerDigest));

describe("layerDigest without crypto.subtle", () => {
  it.effect("computes SHA-256 known vectors", () =>
    withoutSubtle(
      Effect.gen(function* () {
        expect(globalThis.crypto.subtle).toBeUndefined();
        expect(yield* hex(Digest.sha256, new Uint8Array())).toBe(SHA256_EMPTY);
        expect(yield* hex(Digest.sha256, ABC)).toBe(SHA256_ABC);
        const twoBlocks = new TextEncoder().encode(
          "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
        );
        expect(yield* hex(Digest.sha256, twoBlocks)).toBe(SHA256_448_BITS);
      }),
    ),
  );

  it.effect("returns raw bytes from digest", () =>
    withoutSubtle(
      Effect.gen(function* () {
        const digest = yield* Digest.Digest;
        const bytes = yield* digest.digest(Digest.sha256, ABC);
        expect(bytes).toHaveLength(32);
        expect(bytes[0]).toBe(0xba);
      }),
    ),
  );

  it.effect("keeps MD5 working through the algorithm's own implementation", () =>
    withoutSubtle(
      Effect.gen(function* () {
        expect(yield* hex(Digest.md5, ABC)).toBe(MD5_ABC);
      }),
    ),
  );

  it.effect("names the algorithm and the supported ones when the fallback cannot serve it", () =>
    withoutSubtle(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(hex(Digest.sha512, ABC));
        expect(String(exit)).toMatch(/SHA-512.*without crypto\.subtle.*SHA-256/);
      }),
    ),
  );
});

describe("layerDigest with crypto.subtle", () => {
  it.effect("uses crypto.subtle for SHA-256", () =>
    Effect.gen(function* () {
      const spy = vi.spyOn(globalThis.crypto.subtle, "digest");
      expect(yield* hex(Digest.sha256, ABC)).toBe(SHA256_ABC);
      expect(spy).toHaveBeenCalledWith("SHA-256", expect.any(Uint8Array));
      spy.mockRestore();
    }).pipe(Effect.provide(layerDigest)),
  );
});
