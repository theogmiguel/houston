// @effect-diagnostics nodeBuiltinImport:off - local readings of memory, disk and the registry.
// What Night shift reads from this machine and the server around it; every reading is local, so
// preflight sends nothing off the machine. Tests replace each service.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import { ProjectId, type ServerProvider } from "@t3tools/contracts";
import type { ProviderReadiness } from "@t3tools/contracts/houston/providerReadiness";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as HostPowerMonitor from "../../background/HostPowerMonitor.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as HoustonMergeQueueStore from "../mergeQueue/Store.ts";
import { compareReady } from "../tasks/rules.ts";
import * as HoustonTaskService from "../tasks/TaskService.ts";
import { onPath } from "./detect.ts";
import { NightShiftGit } from "./Git.ts";
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

/** The project's merge queue verification command, or null when none is set. */
export class NightShiftMergeQueue extends Context.Service<
  NightShiftMergeQueue,
  { readonly verificationCommand: (projectId: string) => Effect.Effect<string | null> }
>()("houston/houston/nightShift/Host/NightShiftMergeQueue") {}

/** `reg.exe query <args>` as a child process the event loop does not wait on; undefined if absent. */
const regQuery = (args: ReadonlyArray<string>) =>
  Effect.callback<string | undefined>((resume) => {
    NodeChildProcess.execFile(
      "reg.exe",
      ["query", ...args],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
      (error, stdout) => resume(Effect.succeed(error === null ? stdout : undefined)),
    );
  });

/** How a Windows registry key is read; tests replace it. */
export const RegistryQuery = Context.Reference<
  (args: ReadonlyArray<string>) => Effect.Effect<string | undefined>
>("houston/houston/nightShift/Host/RegistryQuery", { defaultValue: () => regQuery });

const REBOOT_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired",
];

const activeHoursValue = (output: string | undefined, name: string) => {
  const match =
    output === undefined
      ? null
      : new RegExp(`${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, "i").exec(output);
  return match === null ? null : Number.parseInt(match[1]!, 16);
};

const availableMemory = (platform: NodeJS.Platform) => {
  if (platform === "linux") {
    try {
      const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(
        NodeFS.readFileSync("/proc/meminfo", "utf8"),
      );
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
  const query = yield* RegistryQuery;
  return NightShiftMachine.of({
    readings: Effect.fn("NightShiftMachine.readings")(function* (root) {
      const onBattery = Option.isSome(power)
        ? (yield* power.value.snapshot).onBattery
        : ("unknown" as const);
      const [settings, ...reboot] =
        platform === "win32"
          ? yield* Effect.all(
              [
                query(["HKLM\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings"]),
                ...REBOOT_KEYS.map((key) => query([key])),
              ],
              { concurrency: "unbounded" },
            )
          : [undefined];
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
        restartPending: reboot.some((output) => output !== undefined),
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

/** The project's merge queue verification command as its settings store it; blank is unset. */
export const layerMergeQueue = Layer.effect(
  NightShiftMergeQueue,
  Effect.gen(function* () {
    const store = yield* HoustonMergeQueueStore.HoustonMergeQueueStore;
    return NightShiftMergeQueue.of({
      verificationCommand: Effect.fn("NightShiftMergeQueue.verificationCommand")(
        function* (projectId) {
          const command = (yield* store.settings(ProjectId.make(projectId))).verificationCommand;
          return command.trim() === "" ? null : command;
        },
      ),
    });
  }),
);

export interface UpNextTask {
  readonly number: number;
  readonly key: string;
  readonly title: string;
  readonly projectId: string | null;
  readonly queue: string;
}

/** The project's Tasks backlog as Night shift picks from it; every read is local. */
export class NightShiftBacklog extends Context.Service<
  NightShiftBacklog,
  {
    /** The project's unarchived tasks in Tasks' ready order. */
    readonly tasks: (projectId: string) => Effect.Effect<ReadonlyArray<UpNextTask>>;
    /** A task's description; empty when it cannot be read. */
    readonly text: (key: string) => Effect.Effect<string>;
    /** Whether the task's status was set to done at or after `since`. */
    readonly doneSince: (key: string, since: string) => Effect.Effect<boolean>;
  }
>()("houston/houston/nightShift/Host/NightShiftBacklog") {}

const statusChangedToDone = (changes: string) => {
  try {
    const parsed = JSON.parse(changes) as { readonly status?: { readonly new?: unknown } };
    return parsed.status?.new === "done";
  } catch {
    return false;
  }
};

/** The backlog over the Tasks service; without one, a project has no tasks to pick. */
export const layerBacklog = Layer.effect(
  NightShiftBacklog,
  Effect.gen(function* () {
    const service = yield* Effect.serviceOption(HoustonTaskService.HoustonTaskService);
    if (Option.isNone(service)) {
      const none: ReadonlyArray<UpNextTask> = [];
      return NightShiftBacklog.of({
        tasks: Effect.fn("NightShiftBacklog.noTasks")(() => Effect.succeed(none)),
        text: Effect.fn("NightShiftBacklog.noText")(() => Effect.succeed("")),
        doneSince: Effect.fn("NightShiftBacklog.notDone")(() => Effect.succeed(false)),
      });
    }
    const tasks = service.value;
    return NightShiftBacklog.of({
      tasks: Effect.fn("NightShiftBacklog.tasks")(
        function* (projectId) {
          const [first] = yield* tasks
            .subscribe({ scope: "all" })
            .pipe(Stream.take(1), Stream.runCollect);
          const all = first !== undefined && "snapshot" in first ? first.snapshot.tasks : [];
          return all
            .filter((task) => task.archivedAt === null && task.projectId === projectId)
            .toSorted(compareReady)
            .map((task) => ({
              number: task.number,
              key: task.key,
              title: task.title,
              projectId: task.projectId,
              queue: task.queue,
            }));
        },
        Effect.orElseSucceed(() => []),
      ),
      text: Effect.fn("NightShiftBacklog.text")(
        function* (key) {
          return (yield* tasks.get({ id: key })).task.description;
        },
        Effect.orElseSucceed(() => ""),
      ),
      doneSince: Effect.fn("NightShiftBacklog.doneSince")(
        function* (key, since) {
          const detail = yield* tasks.get({ id: key });
          return (
            detail.task.status === "done" ||
            detail.history.some(
              (entry) => entry.createdAt >= since && statusChangedToDone(entry.changes),
            )
          );
        },
        Effect.orElseSucceed(() => false),
      ),
    });
  }),
);

/** A pull request's state on GitHub, read once per earlier pull request at a run's start. */
export class NightShiftPullRequests extends Context.Service<
  NightShiftPullRequests,
  {
    readonly state: (
      projectId: ProjectId,
      root: string,
      number: number,
    ) => Effect.Effect<"open" | "closed" | "merged", string>;
  }
>()("houston/houston/nightShift/Host/NightShiftPullRequests") {}

/** `owner/repo` of a github.com remote URL in the https, ssh or scp form; null otherwise. */
export const githubRepository = (url: string): string | null => {
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match === null ? null : `${match[1]}/${match[2]}`;
};

/** Reads through upstream's pull request service; without one, every fate stays unknown. */
export const layerPullRequests = Layer.effect(
  NightShiftPullRequests,
  Effect.gen(function* () {
    const service = yield* Effect.serviceOption(PullRequestService.PullRequestService);
    const git = yield* NightShiftGit;
    return NightShiftPullRequests.of({
      state: Effect.fn("NightShiftPullRequests.state")(function* (projectId, root, number) {
        if (Option.isNone(service)) {
          return yield* Effect.fail("pull request reads are not available on this server");
        }
        const origin = yield* git.origin(root);
        const repository = origin.kind === "origin" ? githubRepository(origin.url) : null;
        if (repository === null) {
          return yield* Effect.fail(`the origin of ${root} is not a github.com repository`);
        }
        const detail = yield* service.value
          .detail({ projectId, host: "github.com", repository, number, allowStale: false })
          .pipe(Effect.mapError((error) => error.message));
        return detail.state;
      }),
    });
  }),
);
