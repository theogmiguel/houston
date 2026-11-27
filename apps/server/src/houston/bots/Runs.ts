// Bot runs after they start: the follower re-derives each one's state from its thread's records
// on the thread events that can change it, records who started each provider turn, stops a bot run
// with its children, and after a restart repeats a launch the server did not finish.
import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type RunId,
  ThreadId,
} from "@houston-app/contracts";
import type {
  HoustonBotAskInput,
  HoustonBotAskResult,
  HoustonBotError,
  HoustonBotRunsListInput,
  HoustonBotRunsListResult,
  HoustonBotRunSummary,
  HoustonBotStopInput,
} from "@houston-app/contracts/houston/bots";
import {
  HOUSTON_BOT_LIMITS,
  HoustonBotRunKind,
  HoustonBotRunState,
} from "@houston-app/contracts/houston/bots";
import { turnItemUpdateCanEndBackgroundWork } from "@houston-app/shared/orchestrationV2PendingBackgroundWork";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { HoustonBotThreads } from "./botThreads.ts";
import { makeLaunch } from "./Launch.ts";
import { refuse } from "./rules.ts";
import {
  deriveBotRunState,
  isClientCommandId,
  latestRunOf,
  startedByOf,
  type BotRunRead,
} from "./runState.ts";
import { HoustonBotStore } from "./Store.ts";

/** How long a stopped thread may ignore Stop before it is force-stopped, as task runs allow. */
const FORCE_STOP_AFTER = "30 seconds";
/** An asked launch interrupted by a restart is repeated only this soon after the click. */
const ASKED_RELAUNCH_MS = 10 * 60_000;
/** Threads remembered as not a bot's; children never change parents, so the answer holds. */
const THREAD_CACHE = 5_000;
/** Continuations followed back to the turn they continue. */
const CONTINUATION_STEPS = 8;

export class HoustonBotRuns extends Context.Service<
  HoustonBotRuns,
  {
    readonly ask: (
      input: HoustonBotAskInput,
    ) => Effect.Effect<HoustonBotAskResult, HoustonBotError>;
    readonly stop: (
      input: HoustonBotStopInput,
    ) => Effect.Effect<HoustonBotRunSummary, HoustonBotError>;
    readonly list: (
      input: HoustonBotRunsListInput,
    ) => Effect.Effect<HoustonBotRunsListResult, HoustonBotError>;
    /** Applies every thread event stored since the last call. */
    readonly catchUp: Effect.Effect<void>;
  }
>()("@houston-app/cli/houston/bots/Runs/HoustonBotRuns") {}

interface BotRunRow {
  readonly id: string;
  readonly bot_id: string;
  readonly bot_name: string;
  readonly kind: string;
  readonly origin: string;
  readonly project_id: string;
  readonly thread_id: string;
  readonly revision_n: number;
  readonly state: string;
  readonly reason: string | null;
  readonly stop_run_id: string | null;
  readonly stop_reason: string | null;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly launch_json: string | null;
}

const OPEN_STATES: ReadonlySet<string> = new Set(["running", "waiting"]);

const isKnownKind = Schema.is(HoustonBotRunKind);
const isKnownState = Schema.is(HoustonBotRunState);

// A literal a newer server stored reads as `other`, as an older client would decode it.
const toSummary = (row: BotRunRow): HoustonBotRunSummary =>
  ({
    id: row.id,
    botId: row.bot_id,
    botName: row.bot_name,
    kind: isKnownKind(row.kind) ? row.kind : "other",
    projectId: row.project_id,
    threadId: row.thread_id,
    revisionN: row.revision_n,
    state: isKnownState(row.state) ? row.state : "other",
    reason: row.reason,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }) as HoustonBotRunSummary;

const followed = (stored: {
  readonly commandId: string | null;
  readonly event: OrchestrationV2DomainEvent;
}) => {
  const { event } = stored;
  switch (event.type) {
    case "run.created":
    case "run.updated":
    case "runtime-request.updated":
    case "provider-thread.updated":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
      return true;
    case "turn-item.updated":
      return (
        event.payload.type === "run_interrupt_request" ||
        turnItemUpdateCanEndBackgroundWork(event.payload)
      );
    default:
      return event.type.startsWith("run.");
  }
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* HoustonBotStore;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const management = yield* ThreadManagement.ThreadManagementService;
  const botThreads = yield* HoustonBotThreads;
  const settings = yield* ServerSettings.ServerSettingsService;
  const launch = yield* makeLaunch;
  const scope = yield* Effect.scope;
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const rowById = (id: string) =>
    run(sql<BotRunRow>`SELECT * FROM houston_bot_runs WHERE id = ${id}`).pipe(
      Effect.map((rows) => rows[0]),
    );

  const readOf = Effect.fn("HoustonBotRuns.readOf")(function* (row: BotRunRow) {
    const threadId = ThreadId.make(row.thread_id);
    const shell = yield* run(orchestrator.getThreadShell(threadId));
    // Not created yet: the launch is still to come.
    if (shell === null && row.launch_json !== null) return undefined;
    const { runs } =
      shell === null ? { runs: [] } : yield* run(orchestrator.getThreadRecords(threadId, ["runs"]));
    const latest = latestRunOf(runs);
    let interrupt: BotRunRead["interrupt"] = null;
    let continuationPending = false;
    if (latest !== undefined) {
      const { turnItems } = yield* run(
        orchestrator.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["run_interrupt_request"],
          turnItemRunIds: [latest.id],
        }),
      );
      const request = turnItems.find((item) => item.type === "run_interrupt_request");
      if (request?.type === "run_interrupt_request") {
        const [turn] = yield* run(sql<{ readonly stopped_by_client: number }>`
          SELECT stopped_by_client FROM houston_bot_turns WHERE run_id = ${latest.id}
        `);
        interrupt = { message: request.message, byClient: turn?.stopped_by_client === 1 };
      }
      const effect = yield* run(outbox.get(`effect:restart-continuation:${latest.id}`));
      continuationPending = Option.exists(
        effect,
        (pending) => pending.status === "pending" || pending.status === "running",
      );
    }
    const read: BotRunRead = {
      kind: row.kind,
      stop:
        row.stop_run_id === null
          ? null
          : { runId: row.stop_run_id, reason: row.stop_reason ?? "stopped" },
      thread: {
        deleted: shell === null || shell.deletedAt !== null,
        archived: shell?.archivedAt != null,
        pendingRuntimeRequest: shell?.pendingRuntimeRequest != null,
        pendingBackground: (shell?.pendingBackgroundTasks?.length ?? 0) > 0,
        lastError: shell?.lastError ?? null,
      },
      runs,
      continuationPending,
      interrupt,
    };
    return { read, runs, shell };
  });

  /** The reason is stored before the interrupt, and explains only the thread run it names. */
  const stopWith = Effect.fn("HoustonBotRuns.stopWith")(function* (row: BotRunRow, reason: string) {
    const threadId = ThreadId.make(row.thread_id);
    const shell = yield* run(orchestrator.getThreadShell(threadId));
    const target = shell?.activeRunId ?? shell?.latestRunId ?? null;
    if (target === null) return;
    yield* run(sql`
      UPDATE houston_bot_runs SET stop_run_id = ${target}, stop_reason = ${reason} WHERE id = ${row.id}
    `);
    // A fixed id would replay as a no-op the second time; one per thread run does not.
    yield* orchestrator
      .dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`houston-bot-run:${row.id}:stop:${target}`),
        threadId,
        reason: `Houston stopped ${row.bot_name}: ${reason}`,
        // Its delegated children are part of the bot run and stop with it.
        stopDelegatedTasks: true,
      })
      .pipe(Effect.ignore);
    yield* Effect.sleep(FORCE_STOP_AFTER).pipe(
      Effect.andThen(run(orchestrator.getThreadShell(threadId))),
      Effect.flatMap((later) =>
        later?.activeRunId === target
          ? management.forceStopThread({ threadId, runId: target as RunId }).pipe(Effect.ignore)
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Houston could not force-stop a bot run's thread", { cause }),
      ),
      Effect.forkIn(scope),
    );
  });

  /** Writes the derived state; a bot run that runs again loses its end time. */
  const refresh = Effect.fn("HoustonBotRuns.refresh")(function* (row: BotRunRow) {
    const found = yield* readOf(row);
    if (found === undefined) return row;
    // A recorded stop also stops the continuation a restart started for that thread run.
    if (
      row.stop_run_id !== null &&
      found.runs.some(
        (candidate) =>
          candidate.restartContinuationOfRunId === row.stop_run_id &&
          (candidate.status === "running" || candidate.status === "starting"),
      )
    ) {
      yield* stopWith(row, row.stop_reason ?? "stopped");
    }
    const derived = deriveBotRunState(found.read);
    if (derived.state === row.state && derived.reason === row.reason) return row;
    const endedAt = OPEN_STATES.has(derived.state) ? null : (row.ended_at ?? (yield* nowIso));
    yield* run(sql`
      UPDATE houston_bot_runs
      SET state = ${derived.state}, reason = ${derived.reason}, ended_at = ${endedAt}
      WHERE id = ${row.id}
    `);
    return { ...row, state: derived.state, reason: derived.reason, ended_at: endedAt };
  });

  const stopUnattended = Effect.fn("HoustonBotRuns.stopUnattended")(function* (
    botId: string | null,
    reason: string,
  ) {
    const rows = yield* run(sql<BotRunRow>`
      SELECT * FROM houston_bot_runs
      WHERE state IN ('running', 'waiting') AND kind != 'asked'
        AND (${botId} IS NULL OR bot_id = ${botId})
    `);
    for (const row of rows) yield* stopWith(row, reason);
  });

  const recordTurns = Effect.fn("HoustonBotRuns.recordTurns")(function* (
    threadId: ThreadId,
    row: BotRunRow,
    child: boolean,
  ) {
    const { runs } = yield* run(orchestrator.getThreadRecords(threadId, ["runs"]));
    const known = new Map(
      (yield* run(sql<{ readonly run_id: string; readonly ended_at: string | null }>`
        SELECT run_id, ended_at FROM houston_bot_turns WHERE thread_id = ${threadId}
      `)).map((turn) => [turn.run_id, turn.ended_at]),
    );
    for (const current of runs) {
      if (current.startedAt === null) continue;
      const endedAt = current.completedAt === null ? null : DateTime.formatIso(current.completedAt);
      if (known.has(current.id)) {
        if (endedAt !== null && known.get(current.id) === null) {
          yield* run(sql`
            UPDATE houston_bot_turns SET ended_at = ${endedAt} WHERE run_id = ${current.id}
          `);
        }
        continue;
      }
      // A restart continuation is the turn it continues.
      let source = current;
      for (let step = 0; step < CONTINUATION_STEPS; step += 1) {
        const previous = runs.find((other) => other.id === source.restartContinuationOfRunId);
        if (previous === undefined) break;
        source = previous;
      }
      const { messages } = yield* run(
        orchestrator.getThreadRecords(threadId, ["messages"], {
          messageIds: [source.userMessageId],
        }),
      );
      const startedBy = startedByOf({
        botRunId: row.id,
        origin: row.origin,
        child,
        message: messages[0],
      });
      const localDate = DateTime.formatIsoDate(
        DateTime.setZone(current.startedAt, DateTime.zoneMakeLocal()),
      );
      yield* run(sql`
        INSERT INTO houston_bot_turns (
          run_id, bot_run_id, thread_id, started_by, local_date, started_at, ended_at
        ) VALUES (
          ${current.id}, ${row.id}, ${threadId}, ${startedBy}, ${localDate},
          ${DateTime.formatIso(current.startedAt)}, ${endedAt}
        )
        ON CONFLICT (run_id) DO NOTHING
      `);
    }
  });

  // A hot path: this and the batch below run for every thread, so they open no span; the steps
  // of a bot run's own thread do.
  const notBots = new Set<string>();
  const botRunOfThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    if (notBots.has(threadId)) return undefined;
    const [own] = yield* run(sql<BotRunRow>`
      SELECT * FROM houston_bot_runs WHERE thread_id = ${threadId}
    `);
    if (own !== undefined) return { row: own, child: false };
    const shell = yield* run(orchestrator.getThreadShell(threadId));
    if (shell === null) return undefined;
    const thread: Pick<OrchestrationV2AppThread, "id" | "lineage" | "houstonBot"> = shell;
    const policy = yield* botThreads.policyOf(thread).pipe(Effect.orElseSucceed(() => undefined));
    const above = policy === undefined ? undefined : yield* rowById(policy.botRunId);
    if (above === undefined) {
      if (notBots.size >= THREAD_CACHE) notBots.clear();
      notBots.add(threadId);
      return undefined;
    }
    return { row: above, child: true };
  });

  const applyBatch = Effect.fnUntraced(function* (
    stored: ReadonlyArray<{
      readonly commandId: string | null;
      readonly event: OrchestrationV2DomainEvent;
    }>,
  ) {
    const threads = new Set<ThreadId>();
    const clientStops: Array<string> = [];
    for (const entry of stored) {
      if (!followed(entry)) continue;
      threads.add(entry.event.threadId);
      const { event } = entry;
      if (
        event.type === "turn-item.updated" &&
        event.payload.type === "run_interrupt_request" &&
        event.payload.runId !== null &&
        isClientCommandId(entry.commandId)
      ) {
        clientStops.push(event.payload.runId);
      }
    }
    const touched = new Map<string, BotRunRow>();
    for (const threadId of threads) {
      const found = yield* botRunOfThread(threadId);
      if (found === undefined) continue;
      yield* recordTurns(threadId, found.row, found.child);
      touched.set(found.row.id, found.row);
    }
    for (const runId of clientStops) {
      yield* run(sql`UPDATE houston_bot_turns SET stopped_by_client = 1 WHERE run_id = ${runId}`);
    }
    for (const row of touched.values()) {
      const current = yield* rowById(row.id);
      if (current !== undefined) yield* refresh(current);
    }
  });

  const [storedCursor] = yield* run(
    sql<{ readonly sequence: number }>`SELECT sequence FROM houston_bot_cursor WHERE id = 1`,
  );
  let cursor = storedCursor?.sequence ?? (yield* run(eventSink.latestSequence()));
  const saveCursor = (sequence: number) =>
    run(sql`
      INSERT INTO houston_bot_cursor (id, sequence) VALUES (1, ${sequence})
      ON CONFLICT (id) DO UPDATE SET sequence = excluded.sequence
    `);
  if (storedCursor === undefined) yield* saveCursor(cursor);
  const catchUpLock = yield* Semaphore.make(1);
  const catchUp: HoustonBotRuns["Service"]["catchUp"] = catchUpLock.withPermits(1)(
    Effect.gen(function* () {
      const latest = yield* run(eventSink.latestSequence());
      if (latest <= cursor) return;
      const events = yield* run(
        eventSink.stream({ afterSequence: cursor }).pipe(
          Stream.takeUntil((entry) => entry.sequence >= latest),
          Stream.runCollect,
        ),
      );
      yield* applyBatch(events).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Houston could not follow its bot runs' threads", { cause }),
        ),
      );
      cursor = events.at(-1)?.sequence ?? latest;
      yield* saveCursor(cursor);
    }),
  );

  const ask: HoustonBotRuns["Service"]["ask"] = Effect.fn("HoustonBotRuns.ask")(function* (input) {
    const answer = yield* launch.ask(input);
    yield* catchUp;
    return answer;
  });

  const stop: HoustonBotRuns["Service"]["stop"] = Effect.fn("HoustonBotRuns.stop")(
    function* (input) {
      const operation = "houston.bots.stop";
      yield* store.requireOn(operation);
      const row = yield* rowById(input.botRunId);
      if (row === undefined) {
        return yield* refuse("not_found", operation, `no bot run ${input.botRunId}`, {
          field: "botRunId",
        });
      }
      // Stopping an ended bot run twice changes nothing.
      if (!OPEN_STATES.has(row.state)) return toSummary(row);
      yield* stopWith(row, "you stopped it");
      yield* catchUp;
      return toSummary((yield* rowById(row.id)) ?? row);
    },
  );

  const list: HoustonBotRuns["Service"]["list"] = Effect.fn("HoustonBotRuns.list")(
    function* (input) {
      yield* store.requireOn("houston.bots.runs.list");
      const page = HOUSTON_BOT_LIMITS.runsPage;
      const rows = yield* run(sql<BotRunRow>`
      SELECT * FROM houston_bot_runs
      WHERE bot_id = ${input.botId} AND (${input.before ?? null} IS NULL OR started_at < ${input.before ?? null})
      ORDER BY started_at DESC, id DESC LIMIT ${page + 1}
    `);
      return { runs: rows.slice(0, page).map(toSummary), hasMore: rows.length > page };
    },
  );

  const recover = Effect.gen(function* () {
    const on = yield* store.isOn;
    const now = yield* DateTime.now;
    const open = yield* run(sql<BotRunRow>`
      SELECT * FROM houston_bot_runs WHERE state IN ('running', 'waiting')
    `);
    for (const row of open) {
      if (row.launch_json !== null) {
        const age = DateTime.toEpochMillis(now) - Date.parse(row.started_at);
        if (on && row.kind === "asked" && age <= ASKED_RELAUNCH_MS) {
          yield* launch.launchRow(row).pipe(Effect.ignore);
        } else {
          yield* run(sql`
            UPDATE houston_bot_runs
            SET state = 'failed', reason = 'Houston stopped before it started',
              ended_at = ${DateTime.formatIso(now)}, launch_json = NULL
            WHERE id = ${row.id}
          `);
        }
        continue;
      }
      const bot = yield* store.find(row.bot_id);
      if (row.kind !== "asked" && (!on || bot?.enabled !== true)) {
        yield* stopWith(
          row,
          on ? `${row.bot_name} was switched off` : "Labs ▸ Bots was turned off",
        );
      }
      yield* refresh(row);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Houston could not recover its bot runs after a restart", { cause }),
    ),
  );

  yield* recover;
  yield* catchUp;

  yield* orchestrator.streamDomainEvents.pipe(
    Stream.runForEach(() => catchUp),
    Effect.catchCause((cause) =>
      Effect.logWarning("Houston stopped following its bot runs' threads", { cause }),
    ),
    Effect.forkScoped,
  );

  // Labs ▸ Bots off, or one bot off: its unattended bot runs stop; asked ones are the owner's.
  const switched = yield* settings.subscribeChanges;
  yield* switched.pipe(
    Stream.map((current) => current.botsEnabled),
    Stream.changes,
    Stream.runForEach((on) =>
      on ? Effect.void : stopUnattended(null, "Labs ▸ Bots was turned off"),
    ),
    Effect.forkScoped,
  );
  const changes = yield* PubSub.subscribe(store.events);
  yield* Stream.fromSubscription(changes).pipe(
    Stream.runForEach((event) =>
      "upserted" in event && !event.upserted.enabled
        ? stopUnattended(event.upserted.id, `${event.upserted.name} was switched off`)
        : Effect.void,
    ),
    Effect.forkScoped,
  );

  return HoustonBotRuns.of({ ask, stop, list, catchUp });
});

export const layer = Layer.effect(HoustonBotRuns, make);
