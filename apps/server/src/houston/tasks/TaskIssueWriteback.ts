// The issue a task is backed by hears the task's hand-back as a comment and, where the project's
// binding maps a pull request URL property, the pull request a run recorded. Failures are logged,
// never turned into a failed task write: the task's own record is the source of truth.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { IssueTrackerKind, ProjectId } from "@houston-app/contracts";

import * as IssueService from "../../issue/IssueService.ts";
import { HoustonTaskTransitions, type TaskTransition } from "./TaskStore.ts";

interface IssueRow {
  readonly task_id: number;
  readonly project_id: string;
  readonly tracker: string;
  readonly host: string;
  readonly scope: string;
  readonly key: string;
  readonly title: string;
  readonly description: string;
}

const COMMENT_CHARS = 60_000;

const handbackActions = new Set(["houston:handback"]);

export class TaskIssueWriteback extends Context.Service<
  TaskIssueWriteback,
  {
    readonly recorded: (transitions: ReadonlyArray<TaskTransition>) => Effect.Effect<void>;
  }
>()("@houston-app/cli/houston/tasks/TaskIssueWriteback") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const issues = yield* Effect.serviceOption(IssueService.IssueService);

  const warn = (taskId: number, message: string) =>
    Effect.logWarning(`Task ${taskId} issue write-back skipped: ${message}`);

  /** Whether the project's binding maps a pull request URL property for this tracker. */
  const mapsPullRequestUrl = (projectId: string, tracker: string) =>
    sql<{ readonly properties_json: string }>`
      SELECT properties_json FROM issue_tracker_bindings
      WHERE project_id = ${projectId} AND tracker = ${tracker}
    `.pipe(
      Effect.map((rows) => {
        const json = rows[0]?.properties_json;
        if (json === undefined) return false;
        try {
          const parsed = JSON.parse(json) as Record<string, unknown>;
          return typeof parsed["prUrl"] === "string" && parsed["prUrl"].length > 0;
        } catch {
          return false;
        }
      }),
      Effect.orDie,
    );

  const write = Effect.fn("TaskIssueWriteback.write")(function* (taskId: number, action: string) {
    const [issue] = yield* sql<IssueRow>`
      SELECT i.task_id, i.project_id, i.tracker, i.host, i.scope, i.key, t.title, t.description
      FROM houston_task_issues i
      JOIN houston_tasks t ON t.id = i.task_id
      WHERE i.task_id = ${taskId}
    `.pipe(Effect.orDie);
    if (issue === undefined) return;
    if (issues._tag === "None") return;
    const [run] = yield* sql<{
      readonly summary: string | null;
      readonly pr_url: string | null;
    }>`
      SELECT summary, pr_url FROM houston_task_runs WHERE task_id = ${taskId}
      ORDER BY id DESC LIMIT 1
    `.pipe(Effect.orDie);
    const ref = {
      projectId: issue.project_id as ProjectId,
      tracker: issue.tracker as IssueTrackerKind,
      host: issue.host,
      scope: issue.scope,
      key: issue.key,
    };
    if (handbackActions.has(action)) {
      const summary = (run?.summary ?? issue.description).trim();
      const body = `${issue.title}: ${summary}`.slice(0, COMMENT_CHARS);
      yield* issues.value
        .comment({ ...ref, body })
        .pipe(
          Effect.catch((error) =>
            warn(taskId, `the hand-back comment was not posted: ${error.message}`),
          ),
        );
    }
    if (run?.pr_url != null && (yield* mapsPullRequestUrl(issue.project_id, issue.tracker))) {
      yield* issues.value
        .setPullRequestUrl({ ...ref, url: run.pr_url })
        .pipe(
          Effect.catch((error) =>
            warn(taskId, `the pull request URL was not written: ${error.message}`),
          ),
        );
    }
  });

  const recorded: TaskIssueWriteback["Service"]["recorded"] = Effect.fn(
    "TaskIssueWriteback.recorded",
  )(function* (transitions) {
    for (const entry of transitions) {
      if (entry.actor.startsWith("tracker:") || entry.action.startsWith("houston:source-")) {
        continue;
      }
      if (!handbackActions.has(entry.action) && entry.action !== "houston:pr-merged") continue;
      yield* write(entry.taskId, entry.action);
    }
  });

  return TaskIssueWriteback.of({ recorded });
});

export const layer = Layer.effect(TaskIssueWriteback, make);

/** The task store's transitions port, served by the issue write-back. */
export const transitionsLayer = Layer.effect(
  HoustonTaskTransitions,
  Effect.map(TaskIssueWriteback, (writeback) =>
    HoustonTaskTransitions.of({ recorded: writeback.recorded }),
  ),
).pipe(Layer.provideMerge(layer));
