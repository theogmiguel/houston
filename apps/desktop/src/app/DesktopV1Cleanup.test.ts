import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  DesktopV1CleanupBinaryNotFoundError,
  DesktopV1CleanupRunError,
  parseV1CleanupReport,
  resolveV1CleanupBinary,
  runV1Cleanup,
  v1CleanupArguments,
  v1CleanupBinaryCandidates,
  type DesktopV1CleanupRunner,
} from "./DesktopV1Cleanup.ts";

const REPORT = {
  stoodDown: false,
  changed: ["/home/theo/.claude/settings.json"],
  messages: ["removed this channel's v1 Houston entries"],
};

describe("v1 cleanup binary", () => {
  it("is resolved from resources when packaged and from the crate target when not", () => {
    assert.deepStrictEqual(
      v1CleanupBinaryCandidates({
        isPackaged: true,
        resourcesPath: "/opt/houston/resources",
        appRoot: "/opt/houston",
        platform: "linux",
      }),
      ["/opt/houston/resources/houston-v1-cleanup"],
    );
    assert.deepStrictEqual(
      v1CleanupBinaryCandidates({
        isPackaged: false,
        resourcesPath: "/unused",
        appRoot: "/repo",
        platform: "win32",
      }),
      [
        "/repo/apps/desktop/native/houston-v1-cleanup/target/release/houston-v1-cleanup.exe",
        "/repo/apps/desktop/native/houston-v1-cleanup/target/debug/houston-v1-cleanup.exe",
      ],
    );
  });

  it("names every path it looked for when the helper is missing", () => {
    const error = (() => {
      try {
        resolveV1CleanupBinary({
          isPackaged: false,
          resourcesPath: "/unused",
          appRoot: "/repo",
          platform: "linux",
          exists: () => false,
        });
      } catch (cause) {
        return cause;
      }
      return undefined;
    })();
    assert.instanceOf(error, DesktopV1CleanupBinaryNotFoundError);
    assert.include(error.message, "/repo/apps/desktop/native/houston-v1-cleanup/target/release");
    assert.include(error.message, "/repo/apps/desktop/native/houston-v1-cleanup/target/debug");
  });

  it("passes the home directory and only a named channel", () => {
    assert.deepStrictEqual(
      v1CleanupArguments({ homeDirectory: "/home/theo", channel: Option.none() }),
      ["--home", "/home/theo"],
    );
    assert.deepStrictEqual(
      v1CleanupArguments({ homeDirectory: "/home/theo", channel: Option.some("dev") }),
      ["--home", "/home/theo", "--channel", "dev"],
    );
  });
});

describe("v1 cleanup invocation", () => {
  it("runs the resolved helper with the host arguments and parses its report", async () => {
    const calls: Array<{ binaryPath: string; args: readonly string[] }> = [];
    const runner: DesktopV1CleanupRunner = {
      run: async (binaryPath, args) => {
        calls.push({ binaryPath, args });
        return { stdout: `${JSON.stringify(REPORT)}\n`, stderr: "" };
      },
    };
    const report = await runV1Cleanup({
      binaryPath: "/repo/helper",
      args: ["--home", "/home/theo"],
      runner,
    });
    assert.deepStrictEqual(report, REPORT);
    assert.deepStrictEqual(calls, [{ binaryPath: "/repo/helper", args: ["--home", "/home/theo"] }]);
  });

  it("reports the helper's stderr and exit code on failure", async () => {
    const runner: DesktopV1CleanupRunner = {
      run: async () => {
        throw Object.assign(new Error("Command failed"), {
          code: 3,
          stderr: "cannot read config",
        });
      },
    };
    const error = await runV1Cleanup({
      binaryPath: "/repo/helper",
      args: [],
      runner,
    }).then(
      () => assert.fail("a failed helper must reject"),
      (cause: unknown) => cause,
    );
    assert.instanceOf(error, DesktopV1CleanupRunError);
    assert.include(error.message, "/repo/helper");
    assert.include(error.message, "cannot read config");
    assert.include(error.message, "3");
  });

  it("rejects a malformed report instead of treating it as empty", () => {
    assert.throws(() => parseV1CleanupReport("/repo/helper", '{"stoodDown":true}'));
  });
});
