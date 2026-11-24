import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import { noticeTopologyChanges } from "./DesktopBackendTopologyNotice.ts";

const baseSpec = (calls: Array<string>): DesktopBackendManager.BackendInstanceSpec => ({
  id: DesktopBackendManager.BackendInstanceId("wsl:Ubuntu"),
  label: Effect.succeed("WSL (Ubuntu)"),
  configResolve: Effect.die("not resolved in this test"),
  onReady: () => Effect.sync(() => calls.push("ready")),
  onStarting: () => Effect.sync(() => calls.push("starting")),
  onPreflightFailed: () => Effect.sync(() => calls.push("preflight")).pipe(Effect.as(false)),
});

describe("noticeTopologyChanges", () => {
  it.effect("announces each lifecycle change after the instance's own hook runs", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const spec = noticeTopologyChanges(
        baseSpec(calls),
        Effect.sync(() => calls.push("notice")),
      );

      yield* spec.onStarting!();
      yield* spec.onReady!(new URL("http://127.0.0.1:3774"), 42);
      expect(yield* spec.onPreflightFailed!({ reason: "distro stopped", fatal: false })).toBe(
        false,
      );
      yield* spec.onShutdown!();
      yield* spec.onStartupFailure!({ reason: "exited", output: "" });
      yield* spec.onAttached!({
        config: {} as DesktopBackendManager.DesktopBackendStartConfig,
        httpBaseUrl: new URL("http://127.0.0.1:3774"),
        pid: 42,
        warning: Option.none(),
      });

      expect(calls).toEqual([
        "starting",
        "notice",
        "ready",
        "notice",
        "preflight",
        "notice",
        "notice",
        "notice",
        "notice",
      ]);
    }),
  );
});
