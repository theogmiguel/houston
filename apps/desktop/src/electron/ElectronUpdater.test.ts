import { assert, describe, it } from "@effect/vitest";

import { appImageCloseInheritedFdsCommand } from "./ElectronUpdater.ts";

const CLOSE_INHERITED_FDS_SCRIPT =
  'for fd in /proc/self/fd/*; do fd=${fd##*/}; case $fd in 0|1|2) ;; *) eval "exec $fd>&-" 2>/dev/null ;; esac; done; exec "$@"';

describe("AppImage relaunch command", () => {
  it("execs the new AppImage from bash after closing inherited descriptors", () => {
    assert.deepStrictEqual(
      appImageCloseInheritedFdsCommand("/home/theo/Apps/Houston-0.21.3.AppImage", ["--updated"]),
      {
        command: "bash",
        args: [
          "-c",
          CLOSE_INHERITED_FDS_SCRIPT,
          "bash",
          "/home/theo/Apps/Houston-0.21.3.AppImage",
          "--updated",
        ],
      },
    );
  });

  it("passes no extra arguments when the updater relaunches without any", () => {
    assert.deepStrictEqual(appImageCloseInheritedFdsCommand("/opt/Houston.AppImage").args, [
      "-c",
      CLOSE_INHERITED_FDS_SCRIPT,
      "bash",
      "/opt/Houston.AppImage",
    ]);
  });
});
