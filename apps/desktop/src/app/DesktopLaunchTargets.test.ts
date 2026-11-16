import { assert, describe, it } from "@effect/vitest";

import { isDeepLink, resolveLaunchTargets, workspaceArgument } from "./DesktopLaunchTargets.ts";

const schemes = ["houston", "houston-dev"];
const folders = new Set(["/work/project", "/work/relative"]);

const resolve = (args: readonly string[], cwd = "/work") =>
  resolveLaunchTargets({
    args: ["/opt/houston", ...args],
    cwd,
    schemes,
    isDirectory: (path) => folders.has(path),
  });

describe("launch targets", () => {
  it("keeps Houston links and existing folders in argument order", () => {
    assert.deepStrictEqual(
      resolve([
        "--channel",
        "dev",
        "houston://pair?url=https%3A%2F%2Fexample.com",
        "/work/project",
        "missing-folder",
      ]),
      {
        webLinks: ["houston://pair?url=https%3A%2F%2Fexample.com"],
        workspaces: ["/work/project"],
      },
    );
  });

  it("resolves relative folders against the launch directory", () => {
    assert.deepStrictEqual(resolve(["relative"]), { webLinks: [], workspaces: ["/work/relative"] });
    assert.deepStrictEqual(resolve(["relative"], "/work/project/.."), {
      webLinks: [],
      workspaces: ["/work/relative"],
    });
  });

  it("ignores flags and other schemes", () => {
    assert.deepStrictEqual(
      resolve(["https://example.com", "work.houston-transfer", "--print-target", "--verbose"]),
      { webLinks: [], workspaces: [] },
    );
  });

  it("accepts only the configured schemes", () => {
    assert.isTrue(isDeepLink("houston://new", schemes));
    assert.isTrue(isDeepLink("houston-dev://new", schemes));
    assert.isFalse(isDeepLink("houston://new", ["houston-dev"]));
    assert.isFalse(isDeepLink("https://example.com", schemes));
  });

  it("skips the executable and a channel value from either spelling", () => {
    assert.deepStrictEqual(resolve(["--channel=dev", "/work/project"]), {
      webLinks: [],
      workspaces: ["/work/project"],
    });
    assert.isNull(workspaceArgument("--channel", "/work", () => true));
  });
});
