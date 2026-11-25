import * as Base64Url from "effect/encoding/Base64Url";
import { describe, expect, it } from "vite-plus/test";

import { decodeIdentityKey, encodeIdentityKey } from "./socketE2eeProtocol.ts";

describe("identity key encoding", () => {
  const key = Uint8Array.from({ length: 32 }, (_, index) => (index * 37 + 251) % 256);

  it("matches Effect's base64url both ways", () => {
    expect(encodeIdentityKey(key)).toBe(Base64Url.encode(key));
    expect(decodeIdentityKey(Base64Url.encode(key))).toEqual(key);
  });

  it("refuses padding, foreign characters and keys of the wrong length", () => {
    const encoded = encodeIdentityKey(key);
    expect(decodeIdentityKey(`${encoded}=`)).toBeUndefined();
    expect(decodeIdentityKey(encoded.replace(/^./, "+"))).toBeUndefined();
    expect(decodeIdentityKey(encodeIdentityKey(key.slice(0, 31)))).toBeUndefined();
    expect(decodeIdentityKey("")).toBeUndefined();
  });
});
