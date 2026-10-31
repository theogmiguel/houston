// @effect-diagnostics nodeBuiltinImport:off - local readings of memory, disk and the registry.
// What Night shift reads from this machine and the server around it; every reading is local, so
// preflight sends nothing off the machine. Tests replace each service.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import type { ServerProvider } from "@t3tools/contracts";
import type { ProviderReadiness } from "@t3tools/contracts/houston/providerReadiness";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as HostPowerMonitor from "../../background/HostPowerMonitor.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { onPath } from "./detect.ts";
import { localTimeZone } from "./window.ts";

export interface MachineReadings {
  readonly onBattery: "true" | "false" | "unknown";
  readonly freeMemoryBytes: number;
  readonly freeDiskBytes: number;
  readonly platform: NodeJS.Platform;
  readonly inhibitAvailable: boolean;
  readonly restartPending: boolean;
  readonly activeHours: { readonly start: number; readonly end: number } | null;
}

export class NightShiftMachine extends Context.Service<
  NightShiftMachine,
  {
    /** Readings for a project rooted at `root`; disk is that volume's. */
    readonly readings: (root: string) => Effect.Effect<MachineReadings>;
    /** Whether `program` is on this machine's PATH. */
    readonly onPath: (program: string) => Effect.Effect<boolean>;
    readonly timeZone: Effect.Effect<string>;
  }
>()("houston/houston/nightShift/Host/NightShiftMachine") {}

export interface ProviderState {
  readonly instanceId: string;
  readonly driver: string;
  readonly readiness: ProviderReadiness | undefined;
}

export class NightShiftProviders extends Context.Service<
  NightShiftProviders,
  { readonly list: Effect.Effect<ReadonlyArray<ProviderState>> }
>()("houston/houston/nightShift/Host/NightShiftProviders") {}

/** The project's merge queue verification command; none until the merge queue is wired in. */
export class NightShiftMergeQueue extends Context.Service<
  NightShiftMergeQueue,
  { readonly verificationCommand: (projectId: string) => Effect.Effect<string | null> }
>()("houston/houston/nightShift/Host/NightShiftMergeQueue") {}

const regQuery = (args: ReadonlyArray<string>) => {
  try {
    return NodeChildProcess.execFileSync("reg.exe", ["query", ...args], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
};

const REBOOT_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired",
];

const activeHoursValue = (output: string | undefined, name: string) => {
  const match = output === undefined ? null : new RegExp(`${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, "i").exec(output);
  return match === null ? null : Number.parseInt(match[1]!, 16);
};

const availableMemory = (platform: NodeJS.Platform) => {
  if (platform === "linux") {
    try {
      const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(NodeFS.readFileSync("/proc/meminfo", "utf8"));
      if (match !== null) return Number(match[1]) * 1024;
    } catch {
      // Falls back to the kernel's free count.
    }
  }
  return NodeOS.freemem();
};

const freeDisk = (root: string) => {
  try {
    const stats = NodeFS.statfsSync(root);
    return stats.bavail * stats.bsize;
  } catch {
    return 0;
  }
};

const makeMachine = Effect.gen(function* () {
  const power = yield* Effect.serviceOption(HostPowerMonitor.HostPowerMonitor);
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const path = onPath(environment, platform);
  return NightShiftMachine.of({
    readings: Effect.fn("NightShiftMachine.readings")(function* (root) {
        const onBattery = Option.isSome(power)
          ? (yield* power.value.snapshot).onBattery
          : ("unknown" as const);
        const settings =
          platform === "win32"
            ? regQuery(["HKLM\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings"])
            : undefined;
        const start = activeHoursValue(settings, "ActiveHoursStart");
        const end = activeHoursValue(settings, "ActiveHoursEnd");
        return {
          onBattery,
          freeMemoryBytes: availableMemory(platform),
          freeDiskBytes: freeDisk(root),
          platform,
          inhibitAvailable:
            platform === "linux"
              ? path("systemd-inhibit")
              : platform === "win32"
                ? path("powershell")
                : false,
          restartPending:
            platform === "win32" && REBOOT_KEYS.some((key) => regQuery([key]) !== undefined),
          activeHours: start === null || end === null ? null : { start, end },
        };
      }),
    onPath: Effect.fn("NightShiftMachine.onPath")((program) => Effect.sync(() => path(program))),
    timeZone: Effect.sync(localTimeZone),
  });
});

export const layerMachine = Layer.effect(NightShiftMachine, makeMachine);

const providerState = (provider: ServerProvider): ProviderState => ({
  instanceId: provider.instanceId,
  driver: provider.driver,
  readiness: provider.readiness,
});

/** Readiness as the registry last published it; reading it starts no probe. */
export const layerProviders = Layer.effect(
  NightShiftProviders,
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry.ProviderRegistry;
    return NightShiftProviders.of({
      list: registry.getProviders.pipe(Effect.map((providers) => providers.map(providerState))),
    });
  }),
);

export const layerMergeQueueUnset = Layer.succeed(
  NightShiftMergeQueue,
  NightShiftMergeQueue.of({
    verificationCommand: Effect.fn("NightShiftMergeQueue.verificationCommand")(() =>
      Effect.succeed(null),
    ),
  }),
);
