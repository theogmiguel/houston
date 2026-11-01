// The rules that decide a Night shift outcome without I/O: the settings' defaults and bounds,
// the window, the idle rule, the headline and the fallback report.
import type { ModelSelection } from "@t3tools/contracts";
import {
  HOUSTON_NIGHT_SHIFT_LIMITS as LIMITS,
  type HoustonNightShiftErrorKind,
  type HoustonNightShiftSettings,
  type NightCheck,
  type NightCrewRole,
  type NightStopReason,
} from "@t3tools/contracts/houston/nightShift";

export const ORCHESTRATOR_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "opencode",
]);
/** Drivers whose readiness never reports a usage limit, so a run could not substitute them. */
const NO_USAGE_LIMIT_DRIVERS: ReadonlySet<string> = new Set(["antigravity"]);

export const clockMinutes = (clock: string): number => {
  const [hours, minutes] = clock.split(":");
  return Number(hours) * 60 + Number(minutes);
};

export const formatMinutes = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
};

export const defaultSettings = (input: {
  readonly orchestrator: ModelSelection;
  readonly checks: ReadonlyArray<NightCheck>;
  readonly startCommand: NightCheck | null;
}): HoustonNightShiftSettings => ({
  v: 3,
  enabled: true,
  window: { wrapUp: "06:45", hardStop: "07:30" },
  focus: {
    reliability: "normal",
    performance: "normal",
    uiPolish: "off",
    competitorGaps: "off",
    docsAccuracy: "off",
    testGaps: "off",
  },
  direction: "",
  competitors: [],
  orchestrator: input.orchestrator,
  workers: [input.orchestrator],
  liveWorkers: 4,
  reviewer: null,
  backlog: { enabled: false, max: 3 },
  output: "prs",
  prSize: { kind: "related", maxChanges: 5 },
  screenshots: true,
  appQa: {
    enabled: false,
    startCommand: input.startCommand?.command ?? null,
    source: input.startCommand?.source ?? null,
    address: null,
    smokeFlows: [],
  },
  holdForQa: true,
  checks: input.checks.slice(0, LIMITS.checks),
  verification: "light",
  questions: "park",
});

export type WindowCheck =
  | { readonly ok: true; readonly minutes: number }
  | { readonly ok: false; readonly message: string };

/** Wrap-up strictly between start and hard stop, and start to hard stop at most 16 hours. */
export const validateWindow = (input: {
  readonly start: string;
  readonly wrapUp: string;
  readonly hardStop: string;
}): WindowCheck => {
  const day = 24 * 60;
  const start = clockMinutes(input.start);
  const span = (clockMinutes(input.hardStop) - start + day) % day || day;
  const wrapUp = (clockMinutes(input.wrapUp) - start + day) % day;
  if (span > LIMITS.windowMinutes) {
    return {
      ok: false,
      message: `start ${input.start} to hard stop ${input.hardStop} is ${formatMinutes(span)}, over the ${formatMinutes(LIMITS.windowMinutes)} limit (wrap-up ${input.wrapUp})`,
    };
  }
  if (wrapUp === 0 || wrapUp >= span) {
    return {
      ok: false,
      message: `wrap-up ${input.wrapUp} must fall strictly between start ${input.start} and hard stop ${input.hardStop}`,
    };
  }
  return { ok: true, minutes: span };
};

export interface SettingsRefusal {
  readonly kind: Extract<HoustonNightShiftErrorKind, "invalid" | "limit" | "unsupported">;
  readonly message: string;
  readonly limit?: number;
  readonly actual?: number;
}

export interface SettingsContext {
  /** The task's start time, HH:MM. */
  readonly start: string;
  /** Each known provider instance's driver. */
  readonly drivers: ReadonlyMap<string, string>;
  /** The project's merge queue verification command, if it has one. */
  readonly mergeQueueVerification: string | null;
}

const between = (field: string, value: number, min: number, max: number): SettingsRefusal | null =>
  value >= min && value <= max
    ? null
    : {
        kind: "limit",
        message: `${field} must be ${min}-${max}; got ${value}`,
        limit: value > max ? max : min,
        actual: value,
      };

const atMost = (field: string, value: number, max: number, unit = ""): SettingsRefusal | null =>
  value <= max
    ? null
    : {
        kind: "limit",
        message: `${field} allows at most ${max}${unit}; got ${value}${unit}`,
        limit: max,
        actual: value,
      };

const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The text the settings carry, counted against the one budget for free text. */
export const settingsText = (settings: HoustonNightShiftSettings): number =>
  settings.direction.length +
  settings.competitors.reduce((sum, competitor) => sum + competitor.repo.length, 0) +
  settings.checks.reduce((sum, check) => sum + check.command.length + check.source.length, 0) +
  (settings.appQa.startCommand?.length ?? 0) +
  (settings.appQa.source?.length ?? 0) +
  (settings.appQa.address?.length ?? 0) +
  settings.appQa.smokeFlows.reduce((sum, flow) => sum + flow.length, 0);

/** The first rule the settings break, or null. */
export const validateSettings = (
  settings: HoustonNightShiftSettings,
  context: SettingsContext,
): SettingsRefusal | null => {
  const window = validateWindow({
    start: context.start,
    wrapUp: settings.window.wrapUp,
    hardStop: settings.window.hardStop,
  });
  if (!window.ok) return { kind: "invalid", message: window.message };

  const bounds = [
    between("liveWorkers", settings.liveWorkers, LIMITS.liveWorkersMin, LIMITS.liveWorkersMax),
    between("workers", settings.workers.length, LIMITS.workersMin, LIMITS.workersMax),
    atMost("checks", settings.checks.length, LIMITS.checks),
    atMost("competitors", settings.competitors.length, LIMITS.competitors),
    atMost("direction", settings.direction.length, LIMITS.directionChars, " characters"),
    atMost("appQa.smokeFlows", settings.appQa.smokeFlows.length, LIMITS.smokeFlows),
    settings.prSize.kind === "related"
      ? between(
          "prSize.maxChanges",
          settings.prSize.maxChanges,
          LIMITS.relatedChangesMin,
          LIMITS.relatedChangesMax,
        )
      : null,
    between("backlog.max", settings.backlog.max, LIMITS.backlogMin, LIMITS.backlogMax),
  ];
  for (const refusal of bounds) if (refusal !== null) return refusal;

  for (const [index, check] of settings.checks.entries()) {
    if (check.command.trim() === "" || /[\r\n]/.test(check.command)) {
      return {
        kind: "invalid",
        message: `checks[${index}] must be one line, not empty; got ${JSON.stringify(check.command.slice(0, 80))}`,
      };
    }
    const bytes = utf8Bytes(check.command);
    if (bytes > LIMITS.checkBytes) {
      return {
        kind: "limit",
        message: `checks[${index}] allows at most ${LIMITS.checkBytes} bytes; got ${bytes} bytes`,
        limit: LIMITS.checkBytes,
        actual: bytes,
      };
    }
  }
  for (const [index, competitor] of settings.competitors.entries()) {
    if (!REPO.test(competitor.repo)) {
      return {
        kind: "invalid",
        message: `competitors[${index}] must be owner/repo; got ${JSON.stringify(competitor.repo)}`,
      };
    }
  }
  const text = settingsText(settings);
  const textRefusal = atMost("text (all free text together)", text, LIMITS.textChars, "");
  if (textRefusal !== null) return textRefusal;

  const selections: ReadonlyArray<readonly [string, ModelSelection]> = [
    ["orchestrator", settings.orchestrator],
    ...settings.workers.map((worker, index) => [`workers[${index}]`, worker] as const),
    ...(settings.reviewer === null ? [] : [["reviewer", settings.reviewer] as const]),
  ];
  for (const [field, selection] of selections) {
    const driver = context.drivers.get(selection.instanceId);
    if (driver !== undefined && NO_USAGE_LIMIT_DRIVERS.has(driver)) {
      return {
        kind: "unsupported",
        message: `${field} ${selection.instanceId} (${driver}) reports no usage limit, so a Night shift run could not replace it when it runs out`,
      };
    }
  }
  const orchestratorDriver = context.drivers.get(settings.orchestrator.instanceId);
  if (orchestratorDriver === undefined || !ORCHESTRATOR_DRIVERS.has(orchestratorDriver)) {
    return {
      kind: "unsupported",
      message: `the orchestrator ${settings.orchestrator.instanceId} runs on ${orchestratorDriver ?? "an unknown driver"}; a Night shift orchestrator runs on claudeAgent, codex or opencode`,
    };
  }

  if (settings.output === "mergeQueue") {
    const missing = [
      context.mergeQueueVerification === null || context.mergeQueueVerification.trim() === ""
        ? "the project's merge queue verification command"
        : null,
      settings.appQa.enabled ? null : "App QA (it is off)",
      settings.appQa.startCommand === null || settings.appQa.startCommand.trim() === ""
        ? "the App QA start command"
        : null,
    ].filter((entry) => entry !== null);
    if (missing.length > 0) {
      return {
        kind: "invalid",
        message: `merge queue output needs ${missing.join(", ")}`,
      };
    }
  }
  if (settings.focus.uiPolish !== "off" && !settings.screenshots) {
    return {
      kind: "invalid",
      message: `UI and UX polish (${settings.focus.uiPolish}) needs screenshots, which are off`,
    };
  }
  return null;
};

/** The idle rule: a nudge after 10 idle minutes, a settle 10 idle minutes after the nudge. */
export const idleDecision = (input: {
  /** Since when the orchestrator has had no active run, no live crew member and no report. */
  readonly idleSinceMs: number | null;
  readonly nudgedAtMs: number | null;
  readonly nowMs: number;
}): "none" | "nudge" | "settle" => {
  if (input.idleSinceMs === null) return "none";
  const window = LIMITS.idleMinutes * 60_000;
  const idleFor = input.nowMs - input.idleSinceMs;
  if (idleFor < window) return "none";
  if (input.nudgedAtMs === null) return "nudge";
  return input.nowMs - input.nudgedAtMs >= window ? "settle" : "none";
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export const headline = (pullRequests: number, openDecisions: number) =>
  `${plural(pullRequests, "pull request", "pull requests")}, ${plural(openDecisions, "open decision", "open decisions")}`;

const STOP_REASONS: Record<NightStopReason, string> = {
  report: "the orchestrator published its report",
  hardStop: "the hard stop passed",
  stopped: "it was stopped",
  idle: "the orchestrator stayed idle after a nudge",
  orchestratorEnded: "the orchestrator ended",
  orchestratorLimited: "the orchestrator's provider stopped being usable",
  serverRestart: "the server restarted after the hard stop",
  launchFailed: "the orchestrator could not be launched",
  imported: "it was imported",
};

export const stopReasonText = (reason: NightStopReason, detail: string | null) =>
  detail === null ? STOP_REASONS[reason] : `${STOP_REASONS[reason]}: ${detail}`;

export interface FallbackEntry {
  readonly kind: string;
  readonly title: string;
  readonly status: string | null;
  readonly prNumber: number | null;
}

/** The report Houston writes when the orchestrator published none. */
export const fallbackReport = (input: {
  readonly runId: number;
  readonly stopReason: NightStopReason;
  readonly stopDetail: string | null;
  readonly endedAt: string;
  readonly entries: ReadonlyArray<FallbackEntry>;
}) => {
  const pullRequests = input.entries.filter((entry) => entry.kind === "pr");
  const decisions = input.entries.filter((entry) => entry.kind === "decision");
  const lines = [
    `# Night shift run ${input.runId}`,
    "",
    `The orchestrator published no report. The run ended at ${input.endedAt} because ${stopReasonText(input.stopReason, input.stopDetail)}.`,
    "",
    `**${headline(pullRequests.length, decisions.filter((entry) => entry.status !== "answered").length)}**`,
    "",
    "## Ledger",
    "",
  ];
  if (input.entries.length === 0) lines.push("Nothing was recorded.");
  for (const entry of input.entries) {
    const number = entry.prNumber === null ? "" : ` #${entry.prNumber}`;
    const status = entry.status === null ? "" : ` (${entry.status})`;
    lines.push(`- ${entry.kind}${number}: ${entry.title}${status}`);
  }
  return `${lines.join("\n")}\n`;
};

/** Milliseconds of `[from, to)` that no downtime interval covers. */
const chargedMs = (
  from: number,
  to: number,
  downtime: ReadonlyArray<{ readonly fromMs: number; readonly toMs: number }>,
) => {
  let charged = Math.max(0, to - from);
  for (const gap of downtime) {
    charged -= Math.max(0, Math.min(to, gap.toMs) - Math.max(from, gap.fromMs));
  }
  return Math.max(0, charged);
};

/** Thread-hours per crew member and instance while the server ran, and tokens per instance where
 * the provider reported them; figures only, so cost never ends a run. */
export const runCost = (input: {
  readonly crew: ReadonlyArray<{
    readonly threadId: string;
    readonly providerInstanceId: string;
    readonly startedAtMs: number;
    readonly endedAtMs: number | null;
  }>;
  /** When the server was not running, so nothing ran. */
  readonly downtime: ReadonlyArray<{ readonly fromMs: number; readonly toMs: number }>;
  /** One row per recorded run usage; null where the provider reported none. */
  readonly usage: ReadonlyArray<{
    readonly providerInstanceId: string;
    readonly tokens: number | null;
  }>;
  readonly nowMs: number;
  /** Nothing runs past the hard stop, so a settle after a long server stop charges up to it only. */
  readonly hardStopMs?: number | null;
}) => {
  const members = input.crew.map((member) => ({
    threadId: member.threadId,
    providerInstanceId: member.providerInstanceId,
    hours:
      chargedMs(
        member.startedAtMs,
        Math.min(member.endedAtMs ?? input.nowMs, input.hardStopMs ?? Number.POSITIVE_INFINITY),
        input.downtime,
      ) / 3_600_000,
  }));
  const instances: Record<string, number> = {};
  for (const member of members) {
    instances[member.providerInstanceId] =
      (instances[member.providerInstanceId] ?? 0) + member.hours;
  }
  const tokens: Record<string, number | "not tracked"> = {};
  for (const instance of [
    ...new Set([...Object.keys(instances), ...input.usage.map((row) => row.providerInstanceId)]),
  ]) {
    const reported = input.usage.filter(
      (row) => row.providerInstanceId === instance && row.tokens !== null,
    );
    tokens[instance] =
      reported.length === 0 ? "not tracked" : reported.reduce((sum, row) => sum + row.tokens!, 0);
  }
  return { members, instances, tokens };
};

/** Roles that count against live workers; review and test each have one slot of their own. */
const WORKER_ROLES: ReadonlySet<NightCrewRole> = new Set([
  "implementation",
  "design",
  "general",
  "research",
]);
/** Roles that build, so each needs a worktree of its own. */
const BUILDING_ROLES: ReadonlySet<NightCrewRole> = new Set([
  "implementation",
  "design",
  "test",
  "general",
]);
/** The live members a review or test slot holds. */
const GATE_ROLE_SLOTS = 1;

/** Why a delegation of `role` would exceed the run's caps, or null when it fits. */
export const crewCapRefusal = (input: {
  /** Roles of the live members other than the orchestrator, reservations included. */
  readonly live: ReadonlyArray<NightCrewRole>;
  readonly role: NightCrewRole;
  readonly liveWorkers: number;
}): string | null => {
  if (WORKER_ROLES.has(input.role)) {
    const count = input.live.filter((role) => WORKER_ROLES.has(role)).length;
    return count < input.liveWorkers
      ? null
      : `${count} of ${input.liveWorkers} live workers are running; a ${input.role} task waits until one ends`;
  }
  const count = input.live.filter((role) => role === input.role).length;
  return count < GATE_ROLE_SLOTS
    ? null
    : `${count} of ${GATE_ROLE_SLOTS} live ${input.role} task is running; a second waits until it ends`;
};

/** Why a delegation's isolation breaks the run's rules, or null when it keeps them. */
export const isolationRefusal = (input: {
  readonly role: NightCrewRole;
  readonly isolation: "shared" | "worktree" | undefined;
  readonly environmentId: string | undefined;
}): string | null => {
  if (input.environmentId !== undefined) {
    return `a Night shift run stays on this machine; target.environmentId ${input.environmentId} is refused`;
  }
  if (BUILDING_ROLES.has(input.role) && input.isolation !== "worktree") {
    return `a ${input.role} task needs its own worktree: pass isolation "worktree" (it was ${input.isolation ?? "shared, the default"})`;
  }
  return null;
};

export interface InstanceState {
  readonly instanceId: string;
  /** Readiness as last published; `missing` when no provider instance has the id. */
  readonly state: string;
  /** Limited for the run until its reset passes and it is ready again. */
  readonly limited: boolean;
}

/** The requested instance when usable, else the chain's next usable one, else a refusal. */
export const substituteInstance = (input: {
  readonly requested: string;
  readonly chain: ReadonlyArray<string>;
  readonly states: ReadonlyMap<string, InstanceState>;
}): { readonly instanceId: string } | { readonly refusal: string } => {
  const usable = (id: string) => {
    const state = input.states.get(id);
    return state !== undefined && state.state === "ready" && !state.limited;
  };
  if (usable(input.requested)) return { instanceId: input.requested };
  const next = input.chain.find(usable);
  if (next !== undefined) return { instanceId: next };
  const named = [...new Set([input.requested, ...input.chain])].map((id) => {
    const state = input.states.get(id);
    const text =
      state === undefined
        ? "missing"
        : state.limited
          ? `${state.state}, limited for this run`
          : state.state;
    return `${id} is ${text}`;
  });
  return { refusal: `no worker instance is ready and unlimited: ${named.join("; ")}` };
};

export interface BacklogTask {
  readonly number: number;
  readonly projectId: string | null;
  readonly queue: string;
}

/** Up to `max` Up next tasks in ready order, skipping earlier picks not done since. */
export const pickTasks = (input: {
  readonly projectId: string;
  readonly max: number;
  /** In Tasks' ready order. */
  readonly backlog: ReadonlyArray<BacklogTask>;
  /** Task numbers earlier runs of the project picked, each with whether it was done since. */
  readonly earlierPicks: ReadonlyMap<number, boolean>;
}): ReadonlyArray<number> =>
  input.backlog
    .filter(
      (task) =>
        task.projectId === input.projectId &&
        task.queue === "up_next" &&
        input.earlierPicks.get(task.number) !== false,
    )
    .slice(0, input.max)
    .map((task) => task.number);
