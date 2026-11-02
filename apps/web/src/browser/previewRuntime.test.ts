import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const env = vi.hoisted(() => ({ hasNativeBrowserHost: false }));

vi.mock("~/env", () => env);
vi.mock("~/previewStateStore", () => ({
  isPreviewSupportedInRuntime: () => env.hasNativeBrowserHost,
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => null } }));
vi.mock("~/state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: {} }));
vi.mock("~/state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => true,
  useEnvironmentSupportsServerBrowser: () => true,
}));

const environmentId = EnvironmentId.make("env-1");

describe("preview runtime", () => {
  beforeEach(() => {
    env.hasNativeBrowserHost = false;
  });

  it("streams a server tab in the Tauri host instead of rendering it as a webview", async () => {
    const { rendersServerTabNatively } = await import("./previewRuntime");
    expect(rendersServerTabNatively(environmentId, environmentId, { runtime: "server" })).toBe(
      false,
    );
  });

  it("renders a non-headless server tab in the Electron webview host", async () => {
    env.hasNativeBrowserHost = true;
    const { rendersServerTabNatively } = await import("./previewRuntime");
    expect(rendersServerTabNatively(environmentId, environmentId, { runtime: "server" })).toBe(
      true,
    );
  });
});
