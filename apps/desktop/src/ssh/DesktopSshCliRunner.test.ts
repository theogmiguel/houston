import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";

import { resolveDesktopSshCliRunner } from "./DesktopSshCliRunner.ts";

describe("resolveDesktopSshCliRunner", () => {
  it("runs the CLI release that matches the server package", () => {
    expect(
      resolveDesktopSshCliRunner({
        isDevelopment: false,
        devRemoteHoustonServerEntryPath: Option.none(),
        serverVersion: "0.19.10",
        serverNodeEngineRange: ">=24",
      }),
    ).toEqual({ archiveVersion: "0.19.10" });
  });

  it("uses the dev server entry when one is configured", () => {
    expect(
      resolveDesktopSshCliRunner({
        isDevelopment: true,
        devRemoteHoustonServerEntryPath: Option.some("/repo/apps/server/src/bin.ts"),
        serverVersion: "0.19.10",
        serverNodeEngineRange: ">=24",
      }),
    ).toEqual({
      nodeScriptPath: "/repo/apps/server/src/bin.ts",
      nodeEngineRange: ">=24",
    });
  });

  it("falls back to the archive outside development even if a dev entry is set", () => {
    expect(
      resolveDesktopSshCliRunner({
        isDevelopment: false,
        devRemoteHoustonServerEntryPath: Option.some("/repo/apps/server/src/bin.ts"),
        serverVersion: "0.19.10",
        serverNodeEngineRange: ">=24",
      }),
    ).toEqual({ archiveVersion: "0.19.10" });
  });
});
