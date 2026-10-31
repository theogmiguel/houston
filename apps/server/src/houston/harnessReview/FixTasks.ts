// The fix tasks linked to a project's findings: each task's status and landing as the Tasks
// backlog records them, and the project's sessions since. It reads tasks and never writes them.
import type { ProjectId } from "@t3tools/contracts";
import type { HoustonTaskStatus } from "@t3tools/contracts/houston/tasks";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";

/** The actor of every task write a harness review makes through the Tasks service. */
export const HARNESS_ACTOR = "houston:harness";

export interface FixTaskLink {
  /** The finding key the task fixes. */
  readonly key: string;
  readonly taskId: number;
  /** `HOU-<n>`. */
  readonly taskKey: string;
  readonly status: HoustonTaskStatus;
  readonly reviewId: number;
  readonly linkedAt: string;
  /** The newest `houston:pr-merged` entry, else when the task became done; null unless done. */
  readonly landedAt: string | null;
  /** Threads of the project created after `landedAt`; 0 before the task lands. */
  readonly sessionsAfter: number;
}

interface LinkRow {
  readonly key: string;
  readonly task_id: number;
  readonly review_id: number;
  readonly created_at: string;
  readonly number: number;
  readonly status: HoustonTaskStatus;
  readonly landed_at: string | null;
}

export class HoustonHarnessFixTasks extends Context.Service<
  HoustonHarnessFixTasks,
  {
    /** The project's links, newest first, without counting sessions. */
    readonly linkStates: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<FixTaskLink>>;
    /** With sessions counted up to `until`, a review's start: its inputs and parser agree. */
    readonly links: (
      projectId: ProjectId,
      until?: string,
    ) => Effect.Effect<ReadonlyArray<FixTaskLink>>;
  }
>()("houston/houston/harnessReview/FixTasks/HoustonHarnessFixTasks") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const linkStates: HoustonHarnessFixTasks["Service"]["linkStates"] = (projectId) =>
    sql<LinkRow>`
      SELECT l.key, l.task_id, l.review_id, l.created_at, t.number, t.status,
        CASE WHEN t.status = 'done' THEN COALESCE(
          (SELECT MAX(h.created_at) FROM houston_task_history h
            WHERE h.task_id = t.id AND h.action = 'houston:pr-merged'),
          (SELECT MAX(h.created_at) FROM houston_task_history h
            WHERE h.task_id = t.id AND json_valid(h.changes)
              AND json_extract(h.changes, '$.status.new') = 'done')
        ) END AS landed_at
      FROM houston_harness_finding_tasks l
      JOIN houston_tasks t ON t.id = l.task_id
      WHERE l.project_id = ${projectId}
      ORDER BY l.created_at DESC, l.task_id DESC
    `.pipe(
      Effect.map((rows) =>
        rows.map((row): FixTaskLink => ({
          key: row.key,
          taskId: row.task_id,
          taskKey: `HOU-${row.number}`,
          status: row.status,
          reviewId: row.review_id,
          linkedAt: row.created_at,
          landedAt: row.landed_at,
          sessionsAfter: 0,
        })),
      ),
      Effect.orDie,
    );

  const links: HoustonHarnessFixTasks["Service"]["links"] = Effect.fn(
    "HoustonHarnessFixTasks.links",
  )(function* (projectId, until) {
    const states = yield* linkStates(projectId);
    const landed = states.filter((link) => link.landedAt !== null);
    if (landed.length === 0) return states;
    const snapshots = yield* Effect.forEach(["active", "archive"] as const, (location) =>
      projections.getShellSnapshot({ location, projectId }),
    ).pipe(Effect.orDie);
    const seen = new Set<string>();
    const threads: Array<{ readonly id: string; readonly createdMs: number }> = [];
    for (const snapshot of snapshots) {
      for (const shell of [...snapshot.threads, ...snapshot.archivedThreads]) {
        if (seen.has(shell.id) || shell.projectId !== projectId) continue;
        seen.add(shell.id);
        if (shell.side?.kind === "harnessReview") continue;
        threads.push({ id: shell.id, createdMs: DateTime.toEpochMillis(shell.createdAt) });
      }
    }
    const runRows = yield* sql<{ task_id: number; thread_id: string }>`
      SELECT task_id, thread_id FROM houston_task_runs
      WHERE thread_id IS NOT NULL AND task_id IN ${sql.in(landed.map((link) => link.taskId))}
    `.pipe(Effect.orDie);
    const untilMs = until === undefined ? Number.POSITIVE_INFINITY : Date.parse(until);
    return states.map((link) => {
      if (link.landedAt === null) return link;
      const landedMs = Date.parse(link.landedAt);
      const own = new Set(
        runRows.filter((row) => row.task_id === link.taskId).map((row) => row.thread_id),
      );
      const sessionsAfter = threads.filter(
        (thread) =>
          thread.createdMs > landedMs && thread.createdMs <= untilMs && !own.has(thread.id),
      ).length;
      return { ...link, sessionsAfter };
    });
  });

  return HoustonHarnessFixTasks.of({ linkStates, links });
});

export const layer = Layer.effect(HoustonHarnessFixTasks, make);
