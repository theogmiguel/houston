import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Metric from "effect/Metric";
import { dual } from "effect/Function";

import { compactMetricAttributes, outcomeFromExit } from "./Attributes.ts";

export const rpcRequestsTotal = Metric.counter("houston_rpc_requests_total", {
  description: "Total RPC requests handled by the websocket RPC server.",
});

export const rpcRequestDuration = Metric.timer("houston_rpc_request_duration", {
  description: "RPC request handling duration.",
});

export const orchestrationCommandsTotal = Metric.counter("houston_orchestration_commands_total", {
  description: "Total orchestration commands dispatched, by outcome.",
});

export const orchestrationCommandDuration = Metric.timer("houston_orchestration_command_duration", {
  description: "Orchestration command handling duration, excluding thread dispatch lock wait.",
});

export const orchestrationEffectClaimsTotal = Metric.counter(
  "houston_orchestration_effect_claims_total",
  {
    description: "Total completed orchestration effect outbox claim attempts by result.",
  },
);

export const orchestrationEffectQueueWait = Metric.timer(
  "houston_orchestration_effect_queue_wait",
  {
    description:
      "Time from an orchestration effect's temporal availability until claim, including same-thread blocking.",
  },
);

export const providerSessionsTotal = Metric.counter("houston_provider_sessions_total", {
  description: "Total provider session lifecycle operations.",
});

export const providerTurnsTotal = Metric.counter("houston_provider_turns_total", {
  description: "Total provider turn lifecycle operations.",
});

export const providerTurnDuration = Metric.timer("houston_provider_turn_duration", {
  description: "Time for the provider adapter to start a turn, not how long the turn runs.",
});

// OTLP carries the unit, and Prometheus names the series by it: a unitless gauge gains `_ratio`.
export const serverResidentBytes = Metric.gauge("houston_server_resident_bytes", {
  description: "Resident memory of the server process.",
  attributes: { unit: "By" },
});

export const serverHeapUsedBytes = Metric.gauge("houston_server_heap_used_bytes", {
  description: "JavaScript heap in use by the server process.",
  attributes: { unit: "By" },
});

export const serverCpuUtilization = Metric.gauge("houston_server_cpu_utilization", {
  description: "CPU time the server used per second over the last sample; 1 is one full core.",
});

export const serverEventLoopUtilization = Metric.gauge("houston_server_event_loop_utilization", {
  description: "Share of the last sample the server's event loop spent busy.",
});

export const serverEventLoopDelayMax = Metric.gauge("houston_server_event_loop_delay_max", {
  description: "Longest event loop delay over the last sample.",
  attributes: { unit: "ms" },
});

export const runsTotal = Metric.counter("houston_runs_total", {
  description: "Runs that finished, by outcome. A later rollback does not count again.",
});

export const runDuration = Metric.timer("houston_run_duration", {
  description: "Wall time of a run, from when it started to its terminal status.",
});

export const runQueueWait = Metric.timer("houston_run_queue_wait", {
  description: "Time a run waited between being requested and starting.",
});

export const gitCommandsTotal = Metric.counter("houston_git_commands_total", {
  description: "Total git commands executed by the server runtime.",
});

export const gitCommandDuration = Metric.timer("houston_git_command_duration", {
  description: "Git command execution duration.",
});

export const terminalSessionsTotal = Metric.counter("houston_terminal_sessions_total", {
  description: "Total terminal sessions started.",
});

export const webhookDeliveriesTotal = Metric.counter("houston_webhook_deliveries_total", {
  description: "Webhook requests handled, by outcome and source.",
});

export const webhookDeliveryDuration = Metric.timer("houston_webhook_delivery_duration", {
  description: "Time to verify, log, and enqueue one webhook request.",
});

export const webhookHeldDelay = Metric.timer("houston_webhook_held_delay", {
  description:
    "Time between the relay receiving a webhook request and the environment handling it.",
});

export const webhookRunsTotal = Metric.counter("houston_webhook_runs_total", {
  description: "Runs started from webhook deliveries, by outcome.",
});

export const secretRequestsTotal = Metric.counter("houston_secret_requests_total", {
  description: "Secrets agents asked users for, by how each request ended.",
});

export const secretRefsConsumedTotal = Metric.counter("houston_secret_refs_consumed_total", {
  description: "Secret refs tools tried to use, by result.",
});

export const metricAttributes = (
  attributes: Readonly<Record<string, unknown>>,
): ReadonlyArray<[string, string]> => Object.entries(compactMetricAttributes(attributes));

export const increment = (
  metric: Metric.Metric<number, unknown>,
  attributes: Readonly<Record<string, unknown>>,
  amount = 1,
) => Metric.update(Metric.withAttributes(metric, metricAttributes(attributes)), amount);

export interface WithMetricsOptions {
  readonly counter?: Metric.Metric<number, unknown>;
  readonly timer?: Metric.Metric<Duration.Duration, unknown>;
  readonly attributes?:
    | Readonly<Record<string, unknown>>
    | (() => Readonly<Record<string, unknown>>);
  readonly outcomeAttributes?: (
    outcome: ReturnType<typeof outcomeFromExit>,
  ) => Readonly<Record<string, unknown>>;
}

const recordMetrics =
  /* Instrumentation must not create its own span for every recorded operation. */
  Effect.fnUntraced(function* (
    options: WithMetricsOptions,
    startedAt: bigint,
    exit: Exit.Exit<unknown, unknown>,
  ) {
    const duration = Duration.nanos((yield* Clock.monotonicTimeNanos) - startedAt);
    const baseAttributes =
      typeof options.attributes === "function" ? options.attributes() : (options.attributes ?? {});

    if (options.timer) {
      yield* Metric.update(
        Metric.withAttributes(options.timer, metricAttributes(baseAttributes)),
        duration,
      );
    }

    if (options.counter) {
      const outcome = outcomeFromExit(exit);
      yield* Metric.update(
        Metric.withAttributes(
          options.counter,
          metricAttributes({
            ...baseAttributes,
            outcome,
            ...(options.outcomeAttributes ? options.outcomeAttributes(outcome) : {}),
          }),
        ),
        1,
      );
    }
  });

// Monotonic timing ignores clock corrections; exit finalizers count interruptions.
const withMetricsImpl = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: WithMetricsOptions,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(Clock.monotonicTimeNanos, (startedAt) =>
    Effect.onExit(effect, (exit) => recordMetrics(options, startedAt, exit)),
  );

export const withMetrics: {
  (
    options: WithMetricsOptions,
  ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  <A, E, R>(effect: Effect.Effect<A, E, R>, options: WithMetricsOptions): Effect.Effect<A, E, R>;
} = dual(2, withMetricsImpl);

// Shaped as an `Effect.fn` combinator: the command is the instrumented function's argument.
export const withCommandMetrics = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  command: { readonly type: string },
): Effect.Effect<A, E, R> =>
  withMetrics(effect, {
    counter: orchestrationCommandsTotal,
    timer: orchestrationCommandDuration,
    attributes: { commandType: command.type },
  });
