// The digest a review reads: one line per thread of the project with a run in the window, built
// only from records the v2 thread store holds. It touches no file; the runner writes the result.
import {
  isProviderNativeSubagentThread,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { maskSecrets } from "./defects/redact.ts";

export const DIGEST_LIMITS = {
  lineBytes: 64 * 1024,
  digestBytes: 2 * 1024 * 1024,
  messageChars: 2_000,
  shortChars: 300,
} as const;

export interface DigestThreadInput {
  readonly thread: Pick<
    OrchestrationV2AppThread,
    | "id"
    | "projectId"
    | "title"
    | "providerInstanceId"
    | "modelSelection"
    | "lineage"
    | "creationSource"
    | "createdBy"
    | "deletedAt"
    | "forkedFrom"
    | "createdAt"
  > & { readonly side?: OrchestrationV2AppThread["side"] };
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  /** `HOU-<n>` when the thread is a task run's. */
  readonly taskKey: string | null;
}

export interface DigestMeta {
  readonly window: { readonly since: string; readonly until: string };
  readonly previousReviewEnd: string | null;
  readonly threadsWritten: number;
  readonly threadsDropped: number;
  readonly prompts: number;
  readonly skipped: {
    readonly deleted: number;
    readonly harnessReview: number;
    readonly subagent: number;
    readonly outsideWindow: number;
  };
}

export interface Digest {
  readonly jsonl: string;
  readonly meta: DigestMeta;
}

const iso = (value: DateTime.DateTime) => DateTime.formatIso(DateTime.toUtc(value));
const millis = (value: DateTime.DateTime) => DateTime.toEpochMillis(value);

/** Masked, then cut to `max` characters with an ellipsis. */
function bounded(text: string, max: number): string {
  const characters = Array.from(maskSecrets(text));
  return characters.length <= max ? characters.join("") : `${characters.slice(0, max).join("")}…`;
}

interface Timed<A> {
  readonly at: number;
  readonly value: A;
}

const TRIMMED = ["prompts", "failures", "approvals", "errors", "subagents"] as const;
type Trimmed = (typeof TRIMMED)[number];

interface Line {
  readonly thread: string;
  readonly title: string;
  readonly provider: string;
  readonly model: string;
  readonly started: string;
  readonly task?: string;
  readonly prompts: Array<Timed<string>>;
  readonly automatic: number;
  readonly failures: Array<Timed<{ command: string; exitCode?: number; status: string }>>;
  readonly approvals: Array<
    Timed<{ kind: string; prompt: string; reason: string; status: string }>
  >;
  readonly interrupts: number;
  readonly compactions: number;
  readonly errors: Array<Timed<string>>;
  readonly subagents: Array<Timed<string>>;
  readonly tools: Record<string, number>;
  lastAssistant: string | null;
  readonly truncated: Record<Trimmed, number>;
  readonly startedMs: number;
}

const TOOL_NAMES: Partial<Record<OrchestrationV2TurnItem["type"], string>> = {
  command_execution: "command",
  file_change: "file_change",
  file_search: "file_search",
  web_search: "web_search",
  subagent: "subagent",
};

function serialize(line: Line): string {
  const values = <A>(entries: ReadonlyArray<Timed<A>>) => entries.map((entry) => entry.value);
  const truncated = Object.fromEntries(
    Object.entries(line.truncated).filter(([, dropped]) => dropped > 0),
  );
  return JSON.stringify({
    thread: line.thread,
    title: line.title,
    provider: line.provider,
    model: line.model,
    started: line.started,
    ...(line.task === undefined ? {} : { task: line.task }),
    prompts: values(line.prompts),
    automatic: line.automatic,
    failures: values(line.failures),
    approvals: values(line.approvals),
    interrupts: line.interrupts,
    compactions: line.compactions,
    errors: values(line.errors),
    subagents: values(line.subagents),
    tools: line.tools,
    last_assistant: line.lastAssistant,
    ...(Object.keys(truncated).length === 0 ? {} : { truncated }),
  });
}

/** Drops the oldest prompts, failures and approvals first, then errors and subagents. */
function fitLine(line: Line): string {
  let text = serialize(line);
  const tiers: ReadonlyArray<ReadonlyArray<Trimmed>> = [
    ["prompts", "failures", "approvals"],
    ["errors", "subagents"],
  ];
  for (const tier of tiers) {
    while (Buffer.byteLength(text) > DIGEST_LIMITS.lineBytes) {
      const oldest = tier
        .filter((name) => line[name].length > 0)
        .toSorted((left, right) => line[left][0]!.at - line[right][0]!.at)[0];
      if (oldest === undefined) break;
      (line[oldest] as Array<Timed<unknown>>).shift();
      line.truncated[oldest] += 1;
      text = serialize(line);
    }
  }
  if (Buffer.byteLength(text) > DIGEST_LIMITS.lineBytes && line.lastAssistant !== null) {
    line.lastAssistant = bounded(line.lastAssistant, DIGEST_LIMITS.shortChars);
    text = serialize(line);
  }
  return text;
}

function buildLine(input: DigestThreadInput, runs: ReadonlyArray<OrchestrationV2Run>): Line {
  const runIds = new Set<string>(runs.map((run) => run.id));
  const ordinal = new Map<string, number>(runs.map((run) => [run.id, run.ordinal]));
  const items = input.turnItems
    .filter(
      (item) => item.threadId === input.thread.id && item.runId !== null && runIds.has(item.runId),
    )
    .toSorted(
      (left, right) =>
        ordinal.get(left.runId!)! - ordinal.get(right.runId!)! || left.ordinal - right.ordinal,
    );
  const first = runs[0]!;
  const startedAt = first.startedAt ?? first.requestedAt;
  const line: Line = {
    thread: input.thread.id,
    title: bounded(input.thread.title, DIGEST_LIMITS.shortChars),
    provider: input.thread.providerInstanceId,
    model: first.modelSelection.model,
    started: iso(startedAt),
    ...(input.taskKey === null ? {} : { task: input.taskKey }),
    prompts: [],
    automatic: 0,
    failures: [],
    approvals: [],
    interrupts: 0,
    compactions: 0,
    errors: [],
    subagents: [],
    tools: {},
    lastAssistant: null,
    truncated: { prompts: 0, failures: 0, approvals: 0, errors: 0, subagents: 0 },
    startedMs: millis(startedAt),
  };
  for (const item of items) {
    const at = millis(item.startedAt ?? item.updatedAt);
    const tool =
      item.type === "dynamic_tool" ? (item.toolName ?? "dynamic_tool") : TOOL_NAMES[item.type];
    if (tool !== undefined) line.tools[tool] = (line.tools[tool] ?? 0) + 1;
    switch (item.type) {
      case "user_message":
        if (
          item.createdBy === "user" &&
          item.scheduledTaskId === undefined &&
          item.senderThreadId === undefined
        ) {
          line.prompts.push({ at, value: bounded(item.text, DIGEST_LIMITS.messageChars) });
        } else {
          (line as { automatic: number }).automatic += 1;
        }
        break;
      case "command_execution":
        if (
          item.status === "failed" ||
          (item.exitCode !== undefined && item.exitCode !== 0) ||
          item.outputIndicatesFailure === true
        ) {
          line.failures.push({
            at,
            value: {
              command: bounded(item.input, DIGEST_LIMITS.shortChars),
              ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
              status: item.status,
            },
          });
        }
        break;
      case "approval_request":
        if (item.status === "failed" || item.status === "cancelled") {
          line.approvals.push({
            at,
            value: {
              kind: item.requestKind,
              prompt: bounded(item.prompt ?? "", DIGEST_LIMITS.shortChars),
              reason: bounded(item.reason ?? "", DIGEST_LIMITS.shortChars),
              status: item.status,
            },
          });
        }
        break;
      case "run_interrupt_request":
        (line as { interrupts: number }).interrupts += 1;
        break;
      case "compaction":
        (line as { compactions: number }).compactions += 1;
        break;
      case "error":
        line.errors.push({ at, value: bounded(item.failure.message, DIGEST_LIMITS.shortChars) });
        break;
      case "subagent":
        line.subagents.push({ at, value: bounded(item.prompt, DIGEST_LIMITS.messageChars) });
        break;
      case "assistant_message":
        if (item.text.trim().length > 0) {
          line.lastAssistant = bounded(item.text, DIGEST_LIMITS.messageChars);
        }
        break;
      default:
        break;
    }
  }
  return line;
}

export function buildDigest(input: {
  readonly projectId: ProjectId;
  readonly window: { readonly sinceMs: number; readonly untilMs: number };
  readonly previousEnd: string | null;
  readonly threads: ReadonlyArray<DigestThreadInput>;
}): Digest {
  const skipped = { deleted: 0, harnessReview: 0, subagent: 0, outsideWindow: 0 };
  const lines: Line[] = [];
  for (const thread of input.threads) {
    if (thread.thread.projectId !== input.projectId) continue;
    if (thread.thread.deletedAt !== null) {
      skipped.deleted += 1;
      continue;
    }
    if (thread.thread.side?.kind === "harnessReview") {
      skipped.harnessReview += 1;
      continue;
    }
    if (isProviderNativeSubagentThread(thread.thread)) {
      skipped.subagent += 1;
      continue;
    }
    const runs = thread.runs
      .filter((run) => {
        if (run.threadId !== thread.thread.id) return false;
        const started = millis(run.startedAt ?? run.requestedAt);
        return started >= input.window.sinceMs && started <= input.window.untilMs;
      })
      .toSorted((left, right) => left.ordinal - right.ordinal);
    if (runs.length === 0) {
      skipped.outsideWindow += 1;
      continue;
    }
    lines.push(buildLine(thread, runs));
  }
  lines.sort((left, right) => right.startedMs - left.startedMs);

  const written: string[] = [];
  let bytes = 0;
  let prompts = 0;
  for (const line of lines) {
    const text = fitLine(line);
    const size = Buffer.byteLength(text) + 1;
    if (bytes + size > DIGEST_LIMITS.digestBytes) break;
    bytes += size;
    prompts += line.prompts.length;
    written.push(text);
  }
  return {
    jsonl: written.map((text) => `${text}\n`).join(""),
    meta: {
      window: {
        since: DateTime.formatIso(DateTime.makeUnsafe(input.window.sinceMs)),
        until: DateTime.formatIso(DateTime.makeUnsafe(input.window.untilMs)),
      },
      previousReviewEnd: input.previousEnd,
      threadsWritten: written.length,
      threadsDropped: lines.length - written.length,
      prompts,
      skipped,
    },
  };
}
