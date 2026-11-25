import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ProviderInstanceEnvironmentVariable,
  isLocalProviderInstance,
} from "./providerInstance.ts";

const decodeEnvironmentVariable = Schema.decodeUnknownSync(ProviderInstanceEnvironmentVariable);

describe("ProviderInstanceEnvironmentVariable", () => {
  it("treats a stored reference as sensitive even when the flag is missing or false", () => {
    const secret = { provider: "onepassword", reference: "op://Private/item/field" };
    expect(decodeEnvironmentVariable({ name: "API_KEY", secret })).toMatchObject({
      value: secret,
      sensitive: true,
    });
    expect(decodeEnvironmentVariable({ name: "API_KEY", sensitive: false, secret }).sensitive).toBe(
      true,
    );
  });
});

describe("isLocalProviderInstance", () => {
  it("follows the linked server while it is enabled", () => {
    const instance = { inference: "local" as const, inferenceServerId: "rtx" as never };
    expect(isLocalProviderInstance(instance, { rtx: { enabled: true } })).toBe(true);
    expect(isLocalProviderInstance(instance, { rtx: { enabled: false } })).toBe(false);
    expect(isLocalProviderInstance(instance, undefined)).toBe(false);
  });

  it("uses the manual mark only when no server is linked", () => {
    expect(isLocalProviderInstance({ inference: "local" }, { rtx: { enabled: false } })).toBe(true);
    expect(isLocalProviderInstance({ inference: "cloud" }, { rtx: { enabled: true } })).toBe(false);
    expect(isLocalProviderInstance(undefined, { rtx: { enabled: true } })).toBe(false);
  });
});
