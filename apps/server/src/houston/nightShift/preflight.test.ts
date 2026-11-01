import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import type { ProviderReadiness } from "@t3tools/contracts/houston/providerReadiness";
import { it as effectIt } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import { layerMachine, NightShiftMachine, RegistryQuery } from "./Host.ts";
import { evaluatePreflight, type PreflightInput } from "./preflight.ts";
import { defaultSettings } from "./rules.ts";

const GIB = 1024 ** 3;
const model = (instance: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instance),
  model: "m",
});

const settings = {
  ...defaultSettings({
    orchestrator: model("claudeAgent"),
    checks: [{ command: "pnpm lint", source: "ci.yml · checks" }],
    startCommand: null,
  }),
  workers: [model("codex"), model("claudeAgent")],
};

const READY: ProviderReadiness = { state: "ready" };
const OUT: ProviderReadiness = {
  state: "outOfUsage",
  resetsAt: "2026-10-31T01:00:00.000Z",
  message: "You've hit your usage limit",
  at: "2026-10-30T20:00:00.000Z",
};
const SIGNED_OUT: ProviderReadiness = {
  state: "signedOut",
  source: "probe",
  message: "Not signed in",
};

const base: PreflightInput = {
  settings,
  readiness: new Map([
    ["claudeAgent", READY],
    ["codex", READY],
  ]),
  onBattery: "false",
  freeMemoryBytes: 16 * GIB,
  freeDiskBytes: 100 * GIB,
  mergeQueueVerification: null,
  platform: "linux",
  inhibitAvailable: true,
  restartPending: false,
  activeHours: null,
  window: {
    startMs: Date.parse("2026-10-30T23:30:00Z"),
    hardStopMs: Date.parse("2026-10-31T07:30:00Z"),
    timeZone: "UTC",
  },
};

const item = (input: PreflightInput, id: string) =>
  evaluatePreflight(input).find((candidate) => candidate.id === id);
const blocks = (input: PreflightInput) =>
  evaluatePreflight(input).filter((candidate) => candidate.status === "block");

describe("night shift preflight", () => {
  it("preflight items and thresholds", () => {
    expect(blocks(base)).toEqual([]);

    const low = item({ ...base, freeMemoryBytes: 5.9 * GIB }, "memory");
    expect(low).toMatchObject({ status: "block", limit: "6 GiB", actual: "5.9 GiB" });
    expect(low?.label.length).toBeGreaterThan(0);
    expect(low?.detail.length).toBeGreaterThan(0);
    expect(item({ ...base, freeMemoryBytes: 6 * GIB }, "memory")?.status).toBe("ok");

    expect(item({ ...base, freeDiskBytes: 19.9 * GIB }, "disk")).toMatchObject({
      status: "block",
      limit: "20 GiB",
      actual: "19.9 GiB",
    });
    expect(item({ ...base, freeDiskBytes: 20 * GIB }, "disk")?.status).toBe("ok");

    expect(item({ ...base, onBattery: "true" }, "on_battery")?.status).toBe("block");
    expect(item({ ...base, onBattery: "unknown" }, "on_battery")?.status).not.toBe("block");

    const orchestratorOut = item(
      { ...base, readiness: new Map([...base.readiness, ["claudeAgent", OUT]]) },
      "orchestrator_not_ready:claudeAgent",
    );
    expect(orchestratorOut?.status).toBe("block");
    expect(orchestratorOut?.detail).toContain("2026-10-31T01:00:00.000Z");
    expect(orchestratorOut?.detail).toContain("You've hit your usage limit");

    // One usable worker is enough: Codex warns, nothing blocks.
    const codexOut: PreflightInput = {
      ...base,
      readiness: new Map([...base.readiness, ["codex", SIGNED_OUT]]),
    };
    expect(item(codexOut, "worker_not_ready:codex")).toMatchObject({ status: "warn" });
    expect(item(codexOut, "worker_not_ready:codex")?.detail).toContain("Not signed in");
    expect(blocks(codexOut)).toEqual([]);
    expect(item(codexOut, "no_worker_ready")).toBeUndefined();

    // Every worker not ready blocks; an unlisted instance is not ready.
    const noWorker = item(
      {
        ...base,
        settings: { ...settings, workers: [model("codex"), model("opencode")] },
        readiness: new Map([...base.readiness, ["codex", SIGNED_OUT]]),
      },
      "no_worker_ready",
    );
    expect(noWorker?.status).toBe("block");

    expect(item({ ...base, settings: { ...settings, checks: [] } }, "checks_missing")?.status).toBe(
      "block",
    );
    expect(
      item(
        {
          ...base,
          settings: {
            ...settings,
            appQa: { ...settings.appQa, enabled: true, startCommand: null },
          },
        },
        "app_qa_start_missing",
      )?.status,
    ).toBe("block");
    expect(
      item({ ...base, settings: { ...settings, output: "mergeQueue" } }, "merge_queue_unset")
        ?.status,
    ).toBe("block");
    expect(
      item(
        { ...base, settings: { ...settings, output: "mergeQueue" }, mergeQueueVerification: "x" },
        "merge_queue_unset",
      ),
    ).toBeUndefined();

    // Every item carries a label and a detail.
    const all = evaluatePreflight({
      ...base,
      freeMemoryBytes: 1 * GIB,
      onBattery: "true",
      settings: { ...settings, checks: [] },
    });
    for (const entry of all) {
      expect(entry.label, entry.id).not.toBe("");
      expect(entry.detail, entry.id).not.toBe("");
    }
  });

  it("platform warnings", () => {
    const windows: PreflightInput = {
      ...base,
      platform: "win32",
      restartPending: true,
      activeHours: { start: 8, end: 17 },
    };
    expect(item(windows, "restart_pending")?.status).toBe("warn");
    const active = item(windows, "active_hours");
    expect(active?.status).toBe("warn");
    expect(active?.detail).toContain("08:00-17:00");
    expect(blocks(windows)).toEqual([]);

    // A window inside the active hours does not warn.
    const inside = item(
      {
        ...windows,
        restartPending: false,
        window: {
          startMs: Date.parse("2026-10-30T09:00:00Z"),
          hardStopMs: Date.parse("2026-10-30T12:00:00Z"),
          timeZone: "UTC",
        },
      },
      "active_hours",
    );
    expect(inside?.status ?? "ok").toBe("ok");

    // Linux evaluates neither; a missing systemd-inhibit warns.
    const linux: PreflightInput = {
      ...base,
      platform: "linux",
      restartPending: true,
      activeHours: { start: 8, end: 17 },
      inhibitAvailable: false,
    };
    expect(item(linux, "restart_pending")).toBeUndefined();
    expect(item(linux, "active_hours")).toBeUndefined();
    expect(item(linux, "inhibit_unavailable")?.status).toBe("warn");
    expect(item(base, "inhibit_unavailable")).toBeUndefined();
    expect(item({ ...base, platform: "darwin" }, "inhibit_unavailable")?.status).toBe("warn");
  });

  effectIt.effect("windows registry readings wait without blocking the event loop", () => {
    const queried: Array<string> = [];
    const outputs: Record<string, string> = {
      "HKLM\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings":
        "    ActiveHoursStart    REG_DWORD    0x8\r\n    ActiveHoursEnd    REG_DWORD    0x11\r\n",
      "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired":
        "found",
    };
    return Effect.gen(function* () {
      const answer = yield* Deferred.make<void>();
      const machine = yield* Effect.service(NightShiftMachine).pipe(
        Effect.provide(
          layerMachine.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(HostProcess.Platform, "win32"),
                Layer.succeed(HostProcess.Environment, { PATH: "" }),
                Layer.succeed(RegistryQuery, (args: ReadonlyArray<string>) =>
                  Effect.sync(() => queried.push(args.join(" "))).pipe(
                    Effect.andThen(Deferred.await(answer)),
                    Effect.as(outputs[args[0]!]),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      const reading = yield* Effect.forkChild(machine.readings(process.cwd()));
      for (let turn = 0; turn < 5; turn += 1) yield* Effect.yieldNow;
      // The registry has not answered: the reading waits, and this fiber still runs.
      expect(queried).toHaveLength(3);
      expect(reading.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(answer, undefined);
      const readings = yield* Fiber.join(reading);
      expect(readings.restartPending).toBe(true);
      expect(readings.activeHours).toEqual({ start: 8, end: 17 });
    });
  });
});
