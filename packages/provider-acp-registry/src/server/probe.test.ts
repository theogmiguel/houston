import { describe, expect, it } from "@effect/vitest";

import { normalizeAcpRegistryWebUrl } from "./probe.ts";

describe("normalizeAcpRegistryWebUrl", () => {
  it("keeps web URLs in their serialized form", () => {
    expect(normalizeAcpRegistryWebUrl("https://Example.test/login")).toBe(
      "https://example.test/login",
    );
    expect(normalizeAcpRegistryWebUrl("http://localhost:8080")).toBe("http://localhost:8080/");
  });

  it("refuses unparseable, non-web and oversized values", () => {
    expect(normalizeAcpRegistryWebUrl("not a url")).toBeUndefined();
    expect(normalizeAcpRegistryWebUrl("file:///etc/passwd")).toBeUndefined();
    expect(normalizeAcpRegistryWebUrl(`https://example.test/${"a".repeat(2_048)}`)).toBeUndefined();
  });
});
