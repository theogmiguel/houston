import { WS_METHODS } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CREDENTIAL_CARRYING_WS_METHODS,
  RPC_SPANS_UNSAMPLED,
  RPC_SPAN_PREFIX,
} from "./RpcInstrumentation.ts";

describe("RPCs that carry a credential", () => {
  it("never record a sampled span, so no payload or result reaches a trace", () => {
    const sampled = CREDENTIAL_CARRYING_WS_METHODS.filter(
      (method) => !RPC_SPANS_UNSAMPLED.has(`${RPC_SPAN_PREFIX}.${method}`),
    );
    expect(sampled).toEqual([]);
  });

  it("name only methods that exist, so a rename cannot silently drop one from the set", () => {
    const known = new Set<string>(Object.values(WS_METHODS));
    const unknown = CREDENTIAL_CARRYING_WS_METHODS.filter((method) => !known.has(method));
    expect(unknown).toEqual([]);
  });

  it("list each method once", () => {
    expect(new Set(CREDENTIAL_CARRYING_WS_METHODS).size).toBe(
      CREDENTIAL_CARRYING_WS_METHODS.length,
    );
  });
});
