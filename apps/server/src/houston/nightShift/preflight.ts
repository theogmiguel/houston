// @effect-diagnostics globalDate:off - Intl reads a zone's wall clock only from a Date.
// The items checked before every start, from readings the caller takes locally: readiness as last
// published, battery, free memory and disk, the settings, and the platform's own warnings.
import type { ProviderReadiness } from "@t3tools/contracts/houston/providerReadiness";
import {
  HOUSTON_NIGHT_SHIFT_LIMITS as LIMITS,
  type HoustonNightShiftSettings,
  type PreflightItem,
} from "@t3tools/contracts/houston/nightShift";

export interface PreflightInput {
  readonly settings: HoustonNightShiftSettings;
  /** Each instance's last published readiness; an unlisted instance is not ready. */
  readonly readiness: ReadonlyMap<string, ProviderReadiness | undefined>;
  readonly onBattery: "true" | "false" | "unknown";
  readonly freeMemoryBytes: number;
  readonly freeDiskBytes: number;
  readonly mergeQueueVerification: string | null;
  readonly platform: NodeJS.Platform;
  /** Whether the keep-awake tool of this platform can be started. */
  readonly inhibitAvailable: boolean;
  /** Windows: a pending-reboot registry key exists. */
  readonly restartPending: boolean;
  /** Windows Update active hours, whole local hours; null when unknown. */
  readonly activeHours: { readonly start: number; readonly end: number } | null;
  readonly window: {
    readonly startMs: number;
    readonly hardStopMs: number;
    readonly timeZone: string;
  };
}

const GIB = 1024 ** 3;
// Rounded down, so a reading below a floor never prints as the floor.
const gib = (bytes: number) => `${(Math.floor((bytes / GIB) * 10 + 1e-9) / 10).toFixed(1)} GiB`;
const gibBound = (bytes: number) => `${bytes / GIB} GiB`;

const readinessText = (readiness: ProviderReadiness | undefined) => {
  if (readiness === undefined) return "not listed among the providers";
  switch (readiness.state) {
    case "ready":
      return "ready";
    case "outOfUsage":
      return `out of usage${readiness.resetsAt === null ? "" : ` until ${readiness.resetsAt}`}: ${readiness.message}`;
    case "signedOut":
      return `signed out: ${readiness.message}`;
    case "rejected":
      return `rejected (${readiness.code}): ${readiness.message}`;
    case "notInstalled":
      return `not installed: ${readiness.message}`;
    case "turnedOff":
      return `turned off: ${readiness.message}`;
  }
};

const isReady = (readiness: ProviderReadiness | undefined) => readiness?.state === "ready";

const hourText = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

/** Local hours [0, 24) the window covers, by the minute. */
const windowHours = (window: PreflightInput["window"]) => {
  const hours = new Set<number>();
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: window.timeZone,
    hour: "numeric",
    hourCycle: "h23",
  });
  for (let at = window.startMs; at < window.hardStopMs; at += 15 * 60_000) {
    hours.add(Number(format.format(new Date(at))));
  }
  return hours;
};

const insideActiveHours = (hour: number, active: { start: number; end: number }) =>
  active.start <= active.end
    ? hour >= active.start && hour < active.end
    : hour >= active.start || hour < active.end;

export const evaluatePreflight = (input: PreflightInput): ReadonlyArray<PreflightItem> => {
  const { settings } = input;
  const items: PreflightItem[] = [];
  const orchestrator = settings.orchestrator.instanceId;
  const orchestratorReadiness = input.readiness.get(orchestrator);
  items.push({
    id: isReady(orchestratorReadiness)
      ? "orchestrator_ready"
      : `orchestrator_not_ready:${orchestrator}`,
    status: isReady(orchestratorReadiness) ? "ok" : "block",
    label: "Orchestrator provider",
    detail: `${orchestrator} is ${readinessText(orchestratorReadiness)}`,
  });

  const workers = settings.workers.map((worker) => worker.instanceId);
  const unready = workers.filter((worker) => !isReady(input.readiness.get(worker)));
  if (unready.length === workers.length) {
    items.push({
      id: "no_worker_ready",
      status: "block",
      label: "Worker providers",
      detail: `no worker provider is ready: ${unready
        .map((worker) => `${worker} is ${readinessText(input.readiness.get(worker))}`)
        .join("; ")}`,
    });
  } else {
    for (const worker of unready) {
      items.push({
        id: `worker_not_ready:${worker}`,
        status: "warn",
        label: "Worker provider skipped",
        detail: `${worker} is ${readinessText(input.readiness.get(worker))}; the run skips it in the chain`,
      });
    }
  }

  items.push({
    id: "on_battery",
    status: input.onBattery === "true" ? "block" : "ok",
    label: "Power",
    detail:
      input.onBattery === "true"
        ? "the machine runs on battery; connect it to power"
        : input.onBattery === "false"
          ? "on AC power"
          : "the power source is unknown",
  });
  const memoryLow = input.freeMemoryBytes < LIMITS.memoryFloorBytes;
  items.push({
    id: "memory",
    status: memoryLow ? "block" : "ok",
    label: "Free memory",
    detail: memoryLow
      ? `${gib(input.freeMemoryBytes)} free, below the ${gibBound(LIMITS.memoryFloorBytes)} a run needs`
      : `${gib(input.freeMemoryBytes)} free`,
    limit: gibBound(LIMITS.memoryFloorBytes),
    actual: gib(input.freeMemoryBytes),
  });
  const diskLow = input.freeDiskBytes < LIMITS.diskFloorBytes;
  items.push({
    id: "disk",
    status: diskLow ? "block" : "ok",
    label: "Free disk on the project's volume",
    detail: diskLow
      ? `${gib(input.freeDiskBytes)} free, below the ${gibBound(LIMITS.diskFloorBytes)} a run needs`
      : `${gib(input.freeDiskBytes)} free`,
    limit: gibBound(LIMITS.diskFloorBytes),
    actual: gib(input.freeDiskBytes),
  });
  if (settings.checks.length === 0) {
    items.push({
      id: "checks_missing",
      status: "block",
      label: "Checks",
      detail: "no check is configured; Houston runs at least one on every pull request head",
    });
  }
  if (settings.appQa.enabled && (settings.appQa.startCommand ?? "").trim() === "") {
    items.push({
      id: "app_qa_start_missing",
      status: "block",
      label: "App QA",
      detail: "App QA is on with no start command",
    });
  }
  if (settings.output === "mergeQueue" && (input.mergeQueueVerification ?? "").trim() === "") {
    items.push({
      id: "merge_queue_unset",
      status: "block",
      label: "Merge queue",
      detail: "merge queue output needs the project's merge queue verification command",
    });
  }

  if (!input.inhibitAvailable || (input.platform !== "linux" && input.platform !== "win32")) {
    items.push({
      id: "inhibit_unavailable",
      status: "warn",
      label: "Keep awake",
      detail:
        input.platform === "linux"
          ? "systemd-inhibit is not available; the machine may sleep during the run"
          : input.platform === "win32"
            ? "powershell.exe is not available; the machine may sleep during the run"
            : `keeping ${input.platform} awake is not supported; the machine may sleep during the run`,
    });
  }
  if (input.platform === "win32") {
    if (input.restartPending) {
      items.push({
        id: "restart_pending",
        status: "warn",
        label: "Pending restart",
        detail: "Windows has a restart pending; an update may restart the machine during the run",
      });
    }
    if (input.activeHours !== null) {
      const active = input.activeHours;
      const outside = [...windowHours(input.window)].some(
        (hour) => !insideActiveHours(hour, active),
      );
      if (outside) {
        items.push({
          id: "active_hours",
          status: "warn",
          label: "Windows Update active hours",
          detail: `the run reaches outside the active hours ${hourText(active.start)}-${hourText(active.end)}, when Windows Update may restart the machine`,
        });
      }
    }
  }
  return items;
};

export const blockingItems = (items: ReadonlyArray<PreflightItem>) =>
  items.filter((item) => item.status === "block");
