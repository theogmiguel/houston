// The rules that decide a Night shift outcome without I/O: the settings' defaults and bounds,
// the window, the idle rule, the headline and the fallback report.
import type { ModelSelection } from "@t3tools/contracts";
import {
  HOUSTON_NIGHT_SHIFT_LIMITS as LIMITS,
  type HoustonNightShiftErrorKind,
  type HoustonNightShiftSettings,
  type NightCheck,
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

/** Thread-hours per crew member and per provider instance, from start to end or now. */
export const threadHours = (
  crew: ReadonlyArray<{
    readonly threadId: string;
    readonly providerInstanceId: string;
    readonly startedAtMs: number;
    readonly endedAtMs: number | null;
  }>,
  nowMs: number,
) => {
  const hours = (member: (typeof crew)[number]) =>
    Math.max(0, (member.endedAtMs ?? nowMs) - member.startedAtMs) / 3_600_000;
  const perInstance: Record<string, number> = {};
  for (const member of crew) {
    perInstance[member.providerInstanceId] =
      (perInstance[member.providerInstanceId] ?? 0) + hours(member);
  }
  return {
    members: crew.map((member) => ({ threadId: member.threadId, hours: hours(member) })),
    instances: perInstance,
    tokens: "not tracked" as const,
  };
};
