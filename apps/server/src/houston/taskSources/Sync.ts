// Merges each remote record into its task, initiative and link in one transaction, and applies
// a conflict resolution at the expected revisions. A remote change never overwrites a task.
// @effect-diagnostics nodeBuiltinImport:off - hashes the remote body for the link.
import * as NodeCrypto from "node:crypto";

import type { ProjectId } from "@t3tools/contracts";
import { HOUSTON_TASK_LIMITS, HoustonTaskStatus } from "@t3tools/contracts/houston/tasks";
import type {
  HoustonTaskSourceConflictResolveInput,
  HoustonTaskSourceError,
  HoustonTaskSourceLink,
  HoustonTaskSourceProvider,
  HoustonTaskSourceSnapshot,
} from "@t3tools/contracts/houston/taskSources";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { checkDescription, checkTaskCount, checkTitle } from "../tasks/rules.ts";
import { HoustonTaskStore, nowIso, toTask, type TaskRow } from "../tasks/TaskStore.ts";
import { HoustonTaskSourceOutbox } from "./Outbox.ts";
import {
  cutChars,
  firstSnapshot,
  mergeProject,
  mergeTaskFields,
  quote,
  recordOverBound,
  refuse,
  resolveInSnapshot,
  resolvedValue,
  syncStateOf,
  withRevision,
  type RemoteRecord,
} from "./rules.ts";
import {
  HoustonTaskSourceStore,
  decodeSnapshot,
  encodeSnapshot,
  encodeSyncState,
  toLink,
  type LinkRow,
  type SourceEvent,
} from "./SourceStore.ts";

const OPERATION = "houston.taskSources.conflict.resolve";
const isTaskStatus = Schema.is(HoustonTaskStatus);

export const trackerActor = (provider: HoustonTaskSourceProvider) => `tracker:${provider}`;

export interface ApplyOutcome {
  /** Why the record was not stored, or null. */
  readonly skipped: string | null;
  readonly taskId: number | null;
  readonly created: boolean;
}

interface InitiativeRow {
  readonly id: number;
  readonly name: string;
  readonly tracker_description: string | null;
  readonly project_external_id: string | null;
  readonly revision: number;
  readonly archived_at: string | null;
}

export class HoustonTaskSourceSync extends Context.Service<
  HoustonTaskSourceSync,
  {
    readonly apply: (
      projectId: ProjectId,
      provider: HoustonTaskSourceProvider,
      record: RemoteRecord,
    ) => Effect.Effect<ApplyOutcome>;
    readonly resolve: (
      input: HoustonTaskSourceConflictResolveInput,
    ) => Effect.Effect<HoustonTaskSourceLink, HoustonTaskSourceError>;
  }
>()("houston/houston/taskSources/Sync/HoustonTaskSourceSync") {}

const encodeBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const bodyHash = (record: RemoteRecord) =>
  NodeCrypto.createHash("sha256")
    .update(encodeBody({ fields: record.fields, project: record.project }))
    .digest("hex");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tasks = yield* HoustonTaskStore;
  const sources = yield* HoustonTaskSourceStore;
  const outbox = yield* HoustonTaskSourceOutbox;
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);

  const linkRow = (projectId: string, provider: string, externalId: string) =>
    run(sql<LinkRow>`
      SELECT * FROM houston_task_source_links
      WHERE project_id = ${projectId} AND provider = ${provider} AND external_id = ${externalId}
        AND source = 'source'
    `).pipe(Effect.map((rows) => rows[0]));

  const initiativeById = (id: number) =>
    run(sql<InitiativeRow>`SELECT * FROM houston_task_initiatives WHERE id = ${id}`).pipe(
      Effect.map((rows) => rows[0]),
    );

  const bumpTask = Effect.fnUntraced(function* (
    taskId: number,
    actor: string,
    action: string,
    changes: object,
  ) {
    const now = yield* nowIso;
    yield* run(sql`
      UPDATE houston_tasks SET revision = revision + 1, updated_at = ${now} WHERE id = ${taskId}
    `);
    yield* tasks.recordHistory(taskId, actor, action, changes);
  });

  const linksEvent = (projectId: string, taskId: number) =>
    sources
      .linksOf(taskId)
      .pipe(
        Effect.map((links): SourceEvent => ({ projectId, event: { links: { taskId, links } } })),
      );

  /** Finds or creates the record's initiative and places the task in it; the identity rule. */
  const placeInInitiative = Effect.fnUntraced(function* (input: {
    readonly projectId: string;
    readonly provider: HoustonTaskSourceProvider;
    readonly taskId: number;
    readonly created: boolean;
    readonly project: NonNullable<RemoteRecord["project"]>;
  }) {
    const key = input.project.externalId;
    const [existing] = yield* run(sql<InitiativeRow>`
      SELECT * FROM houston_task_initiatives
      WHERE project_id = ${input.projectId} AND project_external_id = ${key} AND archived_at IS NULL
      ORDER BY id LIMIT 1
    `);
    const now = yield* nowIso;
    const initiative =
      existing ??
      ((yield* run(sql<InitiativeRow>`
        INSERT INTO houston_task_initiatives (
          project_id, name, external_url, project_external_id, tracker_description,
          local_decisions, revision, updated_at
        ) VALUES (
          ${input.projectId}, ${cutChars(input.project.title.trim() || key, HOUSTON_TASK_LIMITS.titleChars)},
          ${input.project.url}, ${key}, ${input.project.description}, '[]', 1, ${now}
        ) RETURNING *
      `))[0] as InitiativeRow);
    const [domain] = yield* run(sql<{ readonly initiative_id: number | null }>`
      SELECT initiative_id FROM houston_task_domain WHERE task_id = ${input.taskId}
    `);
    let localIdentity: string | null = null;
    if (domain === undefined) {
      yield* run(sql`
        INSERT INTO houston_task_domain (task_id, kind, initiative_id, user_status_override)
        VALUES (${input.taskId}, 'delivery', ${initiative.id}, 0)
      `);
      if (!input.created) {
        yield* bumpTask(
          input.taskId,
          trackerActor(input.provider),
          "houston:source-project-assigned",
          {
            initiativeId: { old: null, new: initiative.id },
          },
        );
      }
    } else if (domain.initiative_id === null && !input.created) {
      yield* run(sql`
        UPDATE houston_task_domain SET initiative_id = ${initiative.id}, approved_task_revision = NULL
        WHERE task_id = ${input.taskId}
      `);
      yield* bumpTask(
        input.taskId,
        trackerActor(input.provider),
        "houston:source-project-assigned",
        {
          initiativeId: { old: null, new: initiative.id },
        },
      );
    } else if (domain.initiative_id !== initiative.id && domain.initiative_id !== null) {
      const current = yield* initiativeById(domain.initiative_id);
      localIdentity = current?.project_external_id ?? `local:${domain.initiative_id}`;
    }
    // Another item's link holds what the tracker last said about this initiative.
    const [other] =
      existing === undefined
        ? []
        : yield* run(sql<{ readonly snapshot_json: string }>`
            SELECT snapshot_json FROM houston_task_source_links
            WHERE project_id = ${input.projectId} AND provider = ${input.provider}
              AND source = 'source' AND task_id != ${input.taskId}
              AND json_extract(snapshot_json, '$.projectExternalId') = ${key}
            ORDER BY fetched_at DESC, task_id DESC LIMIT 1
          `);
    return {
      initiative:
        existing === undefined
          ? null
          : { name: existing.name, description: existing.tracker_description ?? "" },
      localIdentity,
      initiativeId: initiative.id,
      lastRemote: other === undefined ? null : decodeSnapshot(other.snapshot_json).project,
    };
  });

  const apply: HoustonTaskSourceSync["Service"]["apply"] = (projectId, provider, record) => {
    const over = recordOverBound(record);
    if (over !== null) return Effect.succeed({ skipped: over, taskId: null, created: false });
    return sources.write<ApplyOutcome, never, never>(
      Effect.gen(function* () {
        const now = yield* nowIso;
        const existing = yield* linkRow(projectId, provider, record.externalId);
        const touched: Array<number> = [];
        let taskId: number;
        let created = false;
        let previous: HoustonTaskSourceSnapshot | null = null;
        let merged: HoustonTaskSourceSnapshot;
        if (existing === undefined) {
          const count = yield* tasks.taskCount;
          if (checkTaskCount("task source import", count) !== undefined) {
            return {
              result: {
                skipped: `${record.externalId}: the backlog holds ${count} tasks, the limit of ${HOUSTON_TASK_LIMITS.tasks}`,
                taskId: null,
                created: false,
              },
              touched: [],
              events: [],
            };
          }
          const row = yield* tasks.createTask({
            projectId,
            title: record.fields.title as string,
            description: record.fields.description ?? "",
            status: record.fields.status as HoustonTaskStatus,
            priority: "none",
            parentId: null,
            refUrl: record.url,
            acceptance: [],
            createdBy: trackerActor(provider),
          });
          yield* tasks.recordHistory(row.id, trackerActor(provider), "houston:source-imported", {
            provider,
            externalId: record.externalId,
            url: record.url,
          });
          taskId = row.id;
          created = true;
          touched.push(taskId);
          merged = firstSnapshot(record);
        } else {
          taskId = existing.task_id;
          previous = decodeSnapshot(existing.snapshot_json);
          const live = (yield* tasks.taskById(taskId)) as TaskRow;
          merged = mergeTaskFields(
            previous,
            { title: live.title, description: live.description, status: live.status },
            record,
          );
        }
        if (record.project !== null) {
          const before = (yield* tasks.taskById(taskId))?.revision;
          const placed = yield* placeInInitiative({
            projectId,
            provider,
            taskId,
            created,
            project: record.project,
          });
          merged = mergeProject({
            previous,
            merged,
            project: record.project,
            initiative: placed.initiative,
            localIdentity: placed.localIdentity,
            lastRemote: placed.lastRemote,
          });
          if ((yield* tasks.taskById(taskId))?.revision !== before) touched.push(taskId);
        }
        const snapshot =
          previous === null ? { ...merged, revision: 1 } : withRevision(previous, merged);
        const state = encodeSyncState(syncStateOf(snapshot));
        const encoded = encodeSnapshot(snapshot);
        const changed =
          existing === undefined ||
          existing.snapshot_json !== encoded ||
          existing.sync_state_json !== state ||
          existing.url !== record.url;
        if (existing === undefined) {
          yield* run(sql`
            INSERT INTO houston_task_source_links (
              task_id, project_id, provider, external_id, source, url, remote_rev, body_hash,
              fetched_at, synced_at, snapshot_json, sync_state_json
            ) VALUES (
              ${taskId}, ${projectId}, ${provider}, ${record.externalId}, 'source', ${record.url},
              ${record.remoteRev}, ${bodyHash(record)}, ${now}, ${now}, ${encoded}, ${state}
            )
          `);
        } else {
          yield* run(sql`
            UPDATE houston_task_source_links SET url = ${record.url}, remote_rev = ${record.remoteRev},
              body_hash = ${bodyHash(record)}, fetched_at = ${now}, synced_at = ${now},
              snapshot_json = ${encoded}, sync_state_json = ${state}
            WHERE task_id = ${taskId} AND provider = ${provider}
              AND external_id = ${record.externalId} AND source = 'source'
          `);
        }
        // A link's conflicts decide its task's readiness, so a changed link republishes the task.
        if (changed) touched.push(taskId);
        return {
          result: { skipped: null, taskId, created },
          touched,
          events: changed ? [yield* linksEvent(projectId, taskId)] : [],
        };
      }),
    );
  };

  const resolve: HoustonTaskSourceSync["Service"]["resolve"] = (input) =>
    sources.write(
      Effect.gen(function* () {
        const task = yield* tasks
          .resolve(OPERATION, input.taskId)
          .pipe(Effect.mapError(() => refuse("not_found", OPERATION, `no task ${input.taskId}`)));
        const key = toTask(task).key;
        const [row] = yield* run(sql<LinkRow>`
          SELECT * FROM houston_task_source_links
          WHERE task_id = ${task.id} AND provider = ${input.provider}
            AND external_id = ${input.externalId} AND source = 'source'
        `);
        if (row === undefined) {
          return yield* refuse(
            "not_found",
            OPERATION,
            `${key} has no ${input.provider} link to ${quote(input.externalId)}`,
          );
        }
        const snapshot = decodeSnapshot(row.snapshot_json);
        if (snapshot.revision !== input.expectedLinkRevision) {
          return yield* refuse(
            "conflict",
            OPERATION,
            `the link of ${key} expected revision ${input.expectedLinkRevision}, actual revision ${snapshot.revision}`,
            { expected: input.expectedLinkRevision, actual: snapshot.revision },
          );
        }
        if (task.revision !== input.expectedTaskRevision) {
          return yield* refuse(
            "conflict",
            OPERATION,
            `${key} expected revision ${input.expectedTaskRevision}, actual revision ${task.revision}`,
            { expected: input.expectedTaskRevision, actual: task.revision },
          );
        }
        const conflict = snapshot.conflicts.find((entry) => entry.field === input.field);
        if (conflict === undefined) {
          return yield* refuse(
            "invalid",
            OPERATION,
            `${key} has no unresolved ${input.field} conflict on this link`,
            { field: input.field },
          );
        }
        const actor = trackerActor(input.provider);
        const now = yield* nowIso;
        const touched = [task.id];
        let next: HoustonTaskSourceSnapshot;
        if (input.field === "project.title" || input.field === "project.description") {
          const [domain] = yield* run(sql<{ readonly initiative_id: number | null }>`
            SELECT initiative_id FROM houston_task_domain WHERE task_id = ${task.id}
          `);
          const initiative =
            domain?.initiative_id == null ? undefined : yield* initiativeById(domain.initiative_id);
          if (initiative === undefined || initiative.archived_at !== null) {
            return yield* refuse("invalid", OPERATION, `${key} has no active initiative`);
          }
          if (input.expectedInitiativeRevision === undefined) {
            return yield* refuse(
              "invalid",
              OPERATION,
              `expectedInitiativeRevision is required to resolve ${input.field}`,
            );
          }
          if (initiative.revision !== input.expectedInitiativeRevision) {
            return yield* refuse(
              "conflict",
              OPERATION,
              `initiative ${initiative.id} expected revision ${input.expectedInitiativeRevision}, actual revision ${initiative.revision}`,
              { expected: input.expectedInitiativeRevision, actual: initiative.revision },
            );
          }
          const isTitle = input.field === "project.title";
          const live = isTitle ? initiative.name : (initiative.tracker_description ?? "");
          const chosen = resolvedValue(input.resolution, live, conflict.remote);
          if (isTitle) {
            const checked = checkTitle(OPERATION, chosen);
            if (typeof checked !== "string") {
              return yield* refuse(
                checked.kind === "limit" ? "limit" : "invalid",
                OPERATION,
                checked.message,
              );
            }
          } else if (Buffer.byteLength(chosen, "utf8") > HOUSTON_TASK_LIMITS.descriptionBytes) {
            return yield* refuse(
              "limit",
              OPERATION,
              `the initiative description is over ${HOUSTON_TASK_LIMITS.descriptionBytes} bytes`,
            );
          }
          if (chosen !== live) {
            yield* run(
              isTitle
                ? sql`UPDATE houston_task_initiatives SET name = ${chosen.trim()},
                    revision = revision + 1, updated_at = ${now} WHERE id = ${initiative.id}`
                : sql`UPDATE houston_task_initiatives SET tracker_description = ${chosen},
                    revision = revision + 1, updated_at = ${now} WHERE id = ${initiative.id}`,
            );
            const others = yield* run(sql<{ readonly task_id: number }>`
              SELECT task_id FROM houston_task_domain WHERE initiative_id = ${initiative.id}
            `);
            touched.push(...others.map((other) => other.task_id));
          }
          next = resolveInSnapshot(snapshot, input.field, chosen, conflict.remote);
        } else if (input.field === "project.identity") {
          const [domain] = yield* run(
            sql<{
              readonly kind: string;
              readonly initiative_id: number | null;
            }>`SELECT kind, initiative_id FROM houston_task_domain WHERE task_id = ${task.id}`,
          );
          if (domain?.kind !== "delivery" || domain.initiative_id === null) {
            return yield* refuse("invalid", OPERATION, `${key} is not a delivery in an initiative`);
          }
          const current = yield* initiativeById(domain.initiative_id);
          if (input.expectedInitiativeRevision === undefined || current === undefined) {
            return yield* refuse(
              "invalid",
              OPERATION,
              "expectedInitiativeRevision is required to resolve project.identity",
            );
          }
          if (current.revision !== input.expectedInitiativeRevision) {
            return yield* refuse(
              "conflict",
              OPERATION,
              `initiative ${current.id} expected revision ${input.expectedInitiativeRevision}, actual revision ${current.revision}`,
              { expected: input.expectedInitiativeRevision, actual: current.revision },
            );
          }
          const liveIdentity = current.project_external_id ?? `local:${current.id}`;
          const chosen = resolvedValue(input.resolution, liveIdentity, conflict.remote);
          if (chosen !== liveIdentity) {
            const [target] = yield* run(sql<{ readonly id: number }>`
              SELECT id FROM houston_task_initiatives
              WHERE project_id = ${task.project_id} AND project_external_id = ${chosen}
                AND archived_at IS NULL
            `);
            if (target === undefined) {
              return yield* refuse(
                "not_found",
                OPERATION,
                `no active initiative ${quote(chosen)} in ${key}'s project`,
              );
            }
            yield* run(sql`
              UPDATE houston_task_domain SET initiative_id = ${target.id}, approved_task_revision = NULL
              WHERE task_id = ${task.id}
            `);
            yield* bumpTask(task.id, actor, "houston:source-resolved", {
              initiativeId: { old: current.id, new: target.id },
            });
          }
          next = resolveInSnapshot(snapshot, input.field, chosen, conflict.remote);
        } else {
          const field = input.field;
          const live =
            field === "title"
              ? task.title
              : field === "description"
                ? task.description
                : task.status;
          const chosen = resolvedValue(input.resolution, live, conflict.remote);
          if (field === "status" && !isTaskStatus(chosen)) {
            return yield* refuse(
              "invalid",
              OPERATION,
              `${quote(chosen)} is not a task status (backlog, todo, in_progress, in_review, done, canceled)`,
              { field },
            );
          }
          if (field === "title") {
            const checked = checkTitle(OPERATION, chosen);
            if (typeof checked !== "string") {
              return yield* refuse(
                checked.kind === "limit" ? "limit" : "invalid",
                OPERATION,
                checked.message,
              );
            }
          }
          if (field === "description" && checkDescription(OPERATION, chosen) !== undefined) {
            return yield* refuse(
              "limit",
              OPERATION,
              `the description is over ${HOUSTON_TASK_LIMITS.descriptionBytes} bytes`,
            );
          }
          const value = field === "title" ? chosen.trim() : chosen;
          if (value !== live) {
            yield* run(
              field === "title"
                ? sql`UPDATE houston_tasks SET title = ${value}, revision = revision + 1,
                    updated_at = ${now} WHERE id = ${task.id}`
                : field === "description"
                  ? sql`UPDATE houston_tasks SET description = ${value}, revision = revision + 1,
                      updated_at = ${now} WHERE id = ${task.id}`
                  : sql`UPDATE houston_tasks SET status = ${value}, revision = revision + 1,
                      updated_at = ${now} WHERE id = ${task.id}`,
            );
            // As every task edit: an edit invalidates an approved plan.
            yield* run(sql`
              UPDATE houston_task_domain SET approved_task_revision = NULL WHERE task_id = ${task.id}
            `);
            yield* tasks.recordHistory(task.id, actor, "houston:source-resolved", {
              [field]: { old: live, new: value },
            });
            const rolled = yield* tasks.rollup(task.id);
            if (rolled !== undefined) touched.push(rolled);
          }
          if (field === "status") {
            // As Houston 1: keeping the local status is the user's choice; the remote one is not.
            yield* run(sql`
              UPDATE houston_task_domain
              SET user_status_override = ${input.resolution === "remote" ? 0 : 1}
              WHERE task_id = ${task.id}
            `);
          }
          next = resolveInSnapshot(snapshot, field, value, conflict.remote);
          // As Houston 1: a status the user kept or chose goes back to the tracker.
          if (field === "status" && input.resolution !== "remote") {
            yield* outbox.statusResolved(task.id, input.provider);
          }
        }
        yield* run(sql`
          UPDATE houston_task_source_links SET snapshot_json = ${encodeSnapshot(next)},
            sync_state_json = ${encodeSyncState(syncStateOf(next))}
          WHERE task_id = ${task.id} AND provider = ${input.provider}
            AND external_id = ${input.externalId} AND source = 'source'
        `);
        const [updated] = yield* run(sql<LinkRow>`
          SELECT * FROM houston_task_source_links
          WHERE task_id = ${task.id} AND provider = ${input.provider}
            AND external_id = ${input.externalId} AND source = 'source'
        `);
        return {
          result: toLink(updated as LinkRow),
          touched,
          events: [yield* linksEvent(row.project_id, task.id)],
        };
      }),
    );

  return HoustonTaskSourceSync.of({ apply, resolve });
});

export const layer = Layer.effect(HoustonTaskSourceSync, make);
