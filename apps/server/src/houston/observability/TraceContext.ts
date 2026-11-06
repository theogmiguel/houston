// The request context every span and log record carries. Values are ids Houston generated,
// closed enums, numbers or booleans; paths, titles, prompts and user text are not fields here,
// so they cannot be passed.
import * as Effect from "effect/Effect";

import { normalizeModelMetricLabel } from "../../observability/Attributes.ts";

export type ClientKind = "desktop" | "web" | "mobile" | "cli" | "mcp" | "peer";

export interface TraceContextFields {
  readonly projectId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly commandId: string;
  readonly commandType: string;
  readonly effectType: string;
  /** Driver kind (`claude`, `codex`, ...), never a provider instance's name. */
  readonly provider: string;
  /** Model family from `modelFamily`; a custom model string can be user text. */
  readonly model: string;
  readonly clientKind: ClientKind;
  readonly clientId: string | number;
  readonly delegated: boolean;
  readonly subagent: boolean;
  readonly jobName: string;
  readonly jobId: string;
}

const KEYS = {
  projectId: "houston.project.id",
  threadId: "houston.thread.id",
  runId: "houston.run.id",
  turnId: "houston.turn.id",
  commandId: "houston.command.id",
  commandType: "houston.command.type",
  effectType: "houston.effect.type",
  provider: "houston.provider",
  model: "houston.model",
  clientKind: "houston.client.kind",
  clientId: "houston.client.id",
  delegated: "houston.delegated",
  subagent: "houston.subagent",
  jobName: "houston.job.name",
  jobId: "houston.job.id",
} as const satisfies Record<keyof TraceContextFields, `houston.${string}`>;

export type TraceContext = Partial<TraceContextFields>;

export const toAttributes = (context: TraceContext): Record<string, string | number | boolean> => {
  const attributes: Record<string, string | number | boolean> = {};
  for (const field of Object.keys(context) as Array<keyof TraceContextFields>) {
    const value = context[field];
    if (value !== undefined && KEYS[field] !== undefined) attributes[KEYS[field]] = value;
  }
  return attributes;
};

/** The model label a span may carry: a family name, never the configured string. */
export const modelFamily = (model: string | null | undefined): string | undefined =>
  normalizeModelMetricLabel(model);

/** Adds the context to the current span only. */
// oxlint-disable-next-line houston/require-traced-definition -- a span of its own would receive the annotation instead
export const annotate = (context: TraceContext): Effect.Effect<void> =>
  Effect.annotateCurrentSpan(toAttributes(context));

/** Adds the context to the current span, every span and log record inside `self`, forks included. */
export const withTraceContext =
  (context: TraceContext) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    annotate(context).pipe(Effect.andThen(self), withinTraceContext(context));

/** Adds the context to every span and log record inside `self`, but not to the current span. */
export const withinTraceContext =
  (context: TraceContext) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const attributes = toAttributes(context);
    return self.pipe(Effect.annotateSpans(attributes), Effect.annotateLogs(attributes));
  };

/** The context of one outbox effect: its command, thread, request type and run when it has one. */
export const forOutboxEffect = (effect: {
  readonly commandId: string;
  readonly threadId: string;
  readonly request: { readonly type: string };
}): TraceContext => {
  const runId: unknown = "runId" in effect.request ? effect.request.runId : undefined;
  return {
    commandId: effect.commandId,
    threadId: effect.threadId,
    effectType: effect.request.type,
    ...(typeof runId === "string" ? { runId } : {}),
  };
};

/** The context a thread record gives: its project and model family, when the record has them. */
export const forThread = (thread: {
  readonly projectId?: string | undefined;
  readonly modelSelection?: { readonly model?: string | undefined } | undefined;
}): TraceContext => {
  const model = modelFamily(thread.modelSelection?.model);
  return {
    ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
    ...(model === undefined ? {} : { model }),
  };
};
