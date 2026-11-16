import { EnvironmentId } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => true,
  useEnvironmentSupportsServerBrowser: () => true,
}));

const environmentId = EnvironmentId.make("env-1");

describe("preview runtime", () => {
  it("serves a supported environment through the server stream", async () => {
    const { previewRuntimeFor } = await import("./previewRuntime");
    expect(previewRuntimeFor(environmentId)).toBe("server");
  });
});
