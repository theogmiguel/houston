import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  CHANNEL_ENV,
  DesktopChannelValidationError,
  channelShapeRule,
  resolveApplicationName,
  resolveChannelDir,
  resolveDesktopBaseDir,
  resolveDesktopStateDir,
  resolveServerRuntimeRecordPath,
  resolveUserDataDirectoryName,
  validateChannel,
} from "./DesktopStatePaths.ts";

const joinPath = (first: string, ...segments: string[]) => [first, ...segments].join("/");
const home = "/home/theo";

describe("validateChannel", () => {
  it("treats unset, blank and release as the default channel", () => {
    for (const raw of [undefined, "", "   ", "release"]) {
      assert.deepStrictEqual(validateChannel(raw), Option.none());
    }
  });

  it("accepts a named channel and trims it", () => {
    assert.deepStrictEqual(validateChannel("dev"), Option.some("dev"));
    assert.deepStrictEqual(validateChannel("pr-42"), Option.some("pr-42"));
    assert.deepStrictEqual(validateChannel(" dev\n"), Option.some("dev"));
  });

  it("refuses a name that could escape the home directory and names the value and rule", () => {
    for (const raw of ["..", "../etc", "a/b", "/abs", "Dev", "dev_1", "-dev", "dev-", "dev name"]) {
      try {
        validateChannel(raw);
        assert.fail(`${JSON.stringify(raw)} must be refused`);
      } catch (error) {
        assert.instanceOf(error, DesktopChannelValidationError);
        assert.include(error.message, CHANNEL_ENV);
        assert.include(error.message, JSON.stringify(raw));
        assert.include(error.message, channelShapeRule());
      }
    }
    try {
      validateChannel("a".repeat(33));
      assert.fail("an over-long name must be refused");
    } catch (error) {
      assert.instanceOf(error, DesktopChannelValidationError);
    }
  });
});

describe("directory resolution", () => {
  const resolve = (channel: Option.Option<string>, houstonHome: Option.Option<string>) => {
    const channelDir = resolveChannelDir({ homeDirectory: home, joinPath, channel });
    const baseDir = resolveDesktopBaseDir({
      homeDirectory: home,
      joinPath,
      houstonHome,
      channel,
    });
    return {
      channelDir,
      baseDir,
      stateDir: resolveDesktopStateDir({ baseDir, joinPath }),
      runtime: resolveServerRuntimeRecordPath({
        stateDir: resolveDesktopStateDir({ baseDir, joinPath }),
        joinPath,
      }),
    };
  };

  it("uses the release directory for the default channel", () => {
    assert.deepStrictEqual(resolve(Option.none(), Option.none()), {
      channelDir: "/home/theo/.houston",
      baseDir: "/home/theo/.houston/v2",
      stateDir: "/home/theo/.houston/v2/userdata",
      runtime: "/home/theo/.houston/v2/userdata/server-runtime.json",
    });
  });

  it("puts a named channel beside the release directory", () => {
    assert.deepStrictEqual(resolve(Option.some("dev"), Option.none()), {
      channelDir: "/home/theo/.houston-dev",
      baseDir: "/home/theo/.houston-dev/v2",
      stateDir: "/home/theo/.houston-dev/v2/userdata",
      runtime: "/home/theo/.houston-dev/v2/userdata/server-runtime.json",
    });
  });

  it("lets HOUSTON_HOME name the base directory directly", () => {
    assert.deepStrictEqual(
      resolve(Option.some("dev"), Option.some("/worktree/.houston-worktree")),
      {
        channelDir: "/home/theo/.houston-dev",
        baseDir: "/worktree/.houston-worktree",
        stateDir: "/worktree/.houston-worktree/userdata",
        runtime: "/worktree/.houston-worktree/userdata/server-runtime.json",
      },
    );
  });

  it("derives per-channel application and profile names", () => {
    assert.strictEqual(resolveApplicationName(Option.none()), "Houston");
    assert.strictEqual(resolveApplicationName(Option.some("alpha")), "Houston (alpha)");
    assert.strictEqual(resolveUserDataDirectoryName(Option.none()), "Houston");
    assert.strictEqual(resolveUserDataDirectoryName(Option.some("alpha")), "Houston-alpha");
  });
});
