// The server's layout workspaces: one row per workspace in houston_layout_workspaces. Every
// mutation commits in one transaction, bumps the revision of each workspace it changes and then
// publishes the change. The layout holds one tab per content, and never fewer than one workspace.
import {
  HOUSTON_LAYOUT_WORKSPACE_LIMITS,
  type HoustonLayoutColumn,
  HoustonLayoutWorkspaceError,
  type HoustonLayoutWorkspaceDeleteInput,
  type HoustonLayoutWorkspaceDeleteResult,
  type HoustonLayoutWorkspaceErrorKind,
  type HoustonLayoutWorkspacePutInput,
  type HoustonLayoutWorkspacePutResult,
  HoustonLayoutWorkspaceRecord,
  type HoustonLayoutWorkspaceReorderInput,
  type HoustonLayoutWorkspaceStreamEvent,
  findLayoutViolation,
  layoutTabContentKey,
} from "@houston-app/contracts/houston/layoutWorkspaces";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { nowIso } from "./tasks/TaskStore.ts";

const LIMITS = HOUSTON_LAYOUT_WORKSPACE_LIMITS;

export class HoustonLayoutWorkspaceService extends Context.Service<
  HoustonLayoutWorkspaceService,
  {
    /** Every workspace in display order. */
    readonly list: Effect.Effect<
      ReadonlyArray<HoustonLayoutWorkspaceRecord>,
      HoustonLayoutWorkspaceError
    >;
    readonly get: (
      workspaceId: string,
    ) => Effect.Effect<HoustonLayoutWorkspaceRecord, HoustonLayoutWorkspaceError>;
    /** Saves when `expectedRevision` is the stored one (0 creates), else returns the stored one. */
    readonly put: (
      input: HoustonLayoutWorkspacePutInput,
    ) => Effect.Effect<HoustonLayoutWorkspacePutResult, HoustonLayoutWorkspaceError>;
    /** Takes every workspace id once, in the new order. */
    readonly reorder: (
      input: HoustonLayoutWorkspaceReorderInput,
    ) => Effect.Effect<ReadonlyArray<HoustonLayoutWorkspaceRecord>, HoustonLayoutWorkspaceError>;
    /** Moves the workspace's chat tabs to the first remaining workspace; the last one cannot be deleted. */
    readonly delete: (
      input: HoustonLayoutWorkspaceDeleteInput,
    ) => Effect.Effect<HoustonLayoutWorkspaceDeleteResult, HoustonLayoutWorkspaceError>;
    readonly subscribe: Stream.Stream<
      HoustonLayoutWorkspaceStreamEvent,
      HoustonLayoutWorkspaceError
    >;
  }
>()("@houston-app/cli/houston/layoutWorkspaces/HoustonLayoutWorkspaceService") {}

const refuse = (
  kind: HoustonLayoutWorkspaceErrorKind,
  operation: string,
  message: string,
  detail: { field?: string; limit?: number; actual?: number } = {},
) => new HoustonLayoutWorkspaceError({ kind, operation, message, ...detail });

interface WorkspaceRow {
  readonly record_json: string;
}

const decodeRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(HoustonLayoutWorkspaceRecord),
);
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(HoustonLayoutWorkspaceRecord));

const upserted = (record: HoustonLayoutWorkspaceRecord): HoustonLayoutWorkspaceStreamEvent => ({
  upserted: record,
});

const sameContent = (left: HoustonLayoutWorkspaceRecord, right: HoustonLayoutWorkspaceRecord) =>
  encodeRecord({ ...left, revision: 0, updatedAt: "" }) ===
  encodeRecord({ ...right, revision: 0, updatedAt: "" });

const contentKeysOf = (record: HoustonLayoutWorkspaceRecord) =>
  record.columns.flatMap((column) =>
    column.panes.flatMap((pane) => pane.tabs.map((tab) => layoutTabContentKey(tab.content))),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const events = yield* PubSub.unbounded<HoustonLayoutWorkspaceStreamEvent>();
  const lock = yield* Semaphore.make(1);
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);

  const parseRows = (rows: ReadonlyArray<WorkspaceRow>) =>
    Effect.forEach(rows, (row) =>
      Option.match(decodeRecord(row.record_json), {
        onSome: (record) => Effect.succeed([record]),
        onNone: () =>
          Effect.logWarning(
            "Houston layout workspaces: skipped a stored workspace that no longer decodes.",
          ).pipe(Effect.as([] as HoustonLayoutWorkspaceRecord[])),
      }),
    ).pipe(Effect.map((groups) => groups.flat()));

  const readAll = run(
    sql<WorkspaceRow>`
      SELECT record_json FROM houston_layout_workspaces ORDER BY position, created_at, id
    `,
  ).pipe(Effect.flatMap(parseRows));

  const readOne = (workspaceId: string) =>
    run(
      sql<WorkspaceRow>`SELECT record_json FROM houston_layout_workspaces WHERE id = ${workspaceId}`,
    ).pipe(
      Effect.flatMap(parseRows),
      Effect.map((records) => Option.fromNullishOr(records[0])),
    );

  const writeRecord = (record: HoustonLayoutWorkspaceRecord) =>
    run(sql`
      INSERT INTO houston_layout_workspaces (id, position, record_json, revision, created_at, updated_at)
      VALUES (${record.id}, ${record.position}, ${encodeRecord(record)}, ${record.revision},
              ${record.createdAt}, ${record.updatedAt})
      ON CONFLICT (id) DO UPDATE SET
        position = excluded.position,
        record_json = excluded.record_json,
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `);

  /** Runs `body` in a transaction under the lock, then publishes what it returned. */
  const transact = <A, E>(
    body: Effect.Effect<
      { readonly result: A; readonly events: ReadonlyArray<HoustonLayoutWorkspaceStreamEvent> },
      E
    >,
  ) =>
    lock.withPermits(1)(
      sql.withTransaction(body).pipe(
        Effect.catchTags({ SqlError: Effect.die }),
        Effect.tap(({ events: changes }) =>
          Effect.forEach(changes, (change) => PubSub.publish(events, change), { discard: true }),
        ),
        Effect.map(({ result }) => result),
      ),
    );

  /** The size bounds and layout rules a workspace must meet, as the refusal that names them. */
  const checkRecord = Effect.fn("HoustonLayoutWorkspaceService.checkRecord")(function* (
    operation: string,
    record: HoustonLayoutWorkspaceRecord,
  ) {
    const name = record.name.trim();
    if (name.length === 0) {
      return yield* refuse(
        "invalid",
        operation,
        `A workspace name cannot be blank, got '${record.name}' for workspace '${record.id}'.`,
        {
          field: "name",
        },
      );
    }
    if (name.length > LIMITS.nameChars) {
      return yield* refuse(
        "limit",
        operation,
        `A workspace name holds at most ${LIMITS.nameChars} characters, got ${name.length}.`,
        { field: "name", limit: LIMITS.nameChars, actual: name.length },
      );
    }
    if (record.id.length === 0 || record.id.length > LIMITS.idChars) {
      return yield* refuse(
        record.id.length === 0 ? "invalid" : "limit",
        operation,
        `A workspace id holds 1 to ${LIMITS.idChars} characters, got ${record.id.length}.`,
        { field: "id", limit: LIMITS.idChars, actual: record.id.length },
      );
    }
    const violation = findLayoutViolation(record);
    if (violation === undefined) return;
    return yield* refuse(
      violation.kind,
      operation,
      `Workspace '${record.id}': ${violation.message}`,
      {
        field: violation.field,
        ...(violation.limit === undefined ? {} : { limit: violation.limit }),
        ...(violation.actual === undefined ? {} : { actual: violation.actual }),
      },
    );
  });

  const requireUnclaimed = (
    operation: string,
    record: HoustonLayoutWorkspaceRecord,
    others: ReadonlyArray<HoustonLayoutWorkspaceRecord>,
  ) => {
    const owners = new Map<string, string>();
    for (const other of others) {
      for (const key of contentKeysOf(other)) owners.set(key, other.id);
    }
    for (const key of contentKeysOf(record)) {
      const owner = owners.get(key);
      if (owner !== undefined) {
        return Effect.fail(
          refuse(
            "duplicate_content",
            operation,
            `Workspace '${record.id}' has a tab showing ${key}, which workspace '${owner}' already shows; a layout holds one tab per content.`,
            { field: "content" },
          ),
        );
      }
    }
    return Effect.void;
  };

  const list: HoustonLayoutWorkspaceService["Service"]["list"] = readAll;

  const get: HoustonLayoutWorkspaceService["Service"]["get"] = (workspaceId) =>
    readOne(workspaceId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              refuse("not_found", "houston.layoutWorkspaces.get", `no workspace '${workspaceId}'`, {
                field: "workspaceId",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const put: HoustonLayoutWorkspaceService["Service"]["put"] = Effect.fn(
    "HoustonLayoutWorkspaceService.put",
  )(function* (input) {
    const operation = "houston.layoutWorkspaces.put";
    const incoming = { ...input.workspace, name: input.workspace.name.trim() };
    yield* checkRecord(operation, incoming);
    return yield* transact<HoustonLayoutWorkspacePutResult, HoustonLayoutWorkspaceError>(
      Effect.gen(function* () {
        const all = yield* readAll;
        const others = all.filter((workspace) => workspace.id !== incoming.id);
        const current = all.find((workspace) => workspace.id === incoming.id);
        if (current === undefined) {
          if (input.expectedRevision !== 0) {
            return { result: { status: "conflict", current: null } as const, events: [] };
          }
          if (all.length >= LIMITS.workspaces) {
            return yield* refuse(
              "limit",
              operation,
              `Cannot create workspace '${incoming.id}': there are already ${all.length} workspaces, the limit is ${LIMITS.workspaces}, and the request adds 1 more.`,
              { field: "workspaces", limit: LIMITS.workspaces, actual: all.length },
            );
          }
          yield* requireUnclaimed(operation, incoming, others);
          const now = yield* nowIso;
          const record = {
            ...incoming,
            position: all.reduce((max, workspace) => Math.max(max, workspace.position + 1), 0),
            revision: 1,
            createdAt: now,
            updatedAt: now,
          };
          yield* writeRecord(record);
          return {
            result: { status: "saved", workspace: record } as const,
            events: [upserted(record)],
          };
        }
        if (current.revision !== input.expectedRevision) {
          return { result: { status: "conflict", current } as const, events: [] };
        }
        yield* requireUnclaimed(operation, incoming, others);
        const candidate: HoustonLayoutWorkspaceRecord = {
          ...incoming,
          position: current.position,
          createdAt: current.createdAt,
        };
        if (sameContent(current, candidate)) {
          return { result: { status: "saved", workspace: current } as const, events: [] };
        }
        const record = { ...candidate, revision: current.revision + 1, updatedAt: yield* nowIso };
        yield* writeRecord(record);
        return {
          result: { status: "saved", workspace: record } as const,
          events: [upserted(record)],
        };
      }),
    );
  });

  const reorder: HoustonLayoutWorkspaceService["Service"]["reorder"] = Effect.fn(
    "HoustonLayoutWorkspaceService.reorder",
  )(function* (input) {
    const operation = "houston.layoutWorkspaces.reorder";
    return yield* transact<
      ReadonlyArray<HoustonLayoutWorkspaceRecord>,
      HoustonLayoutWorkspaceError
    >(
      Effect.gen(function* () {
        const all = yield* readAll;
        const stored = new Set(all.map((workspace) => workspace.id));
        const seen = new Set<string>();
        for (const id of input.workspaceIds) {
          if (!stored.has(id)) {
            return yield* refuse("invalid", operation, `Cannot reorder: no workspace '${id}'.`, {
              field: "workspaceIds",
            });
          }
          if (seen.has(id)) {
            return yield* refuse(
              "invalid",
              operation,
              `Cannot reorder: workspace '${id}' is listed more than once.`,
              { field: "workspaceIds" },
            );
          }
          seen.add(id);
        }
        const missing = all
          .filter((workspace) => !seen.has(workspace.id))
          .map((workspace) => workspace.id);
        if (missing.length > 0) {
          return yield* refuse(
            "invalid",
            operation,
            `Cannot reorder: the request names ${seen.size} of ${all.length} workspaces and omits ${missing.map((id) => `'${id}'`).join(", ")}; it must list every workspace once.`,
            { field: "workspaceIds" },
          );
        }
        const now = yield* nowIso;
        const byId = new Map(all.map((workspace) => [workspace.id, workspace] as const));
        const ordered: HoustonLayoutWorkspaceRecord[] = [];
        const changes: HoustonLayoutWorkspaceStreamEvent[] = [];
        for (const [index, id] of input.workspaceIds.entries()) {
          const before = byId.get(id)!;
          if (before.position === index) {
            ordered.push(before);
            continue;
          }
          const record = {
            ...before,
            position: index,
            revision: before.revision + 1,
            updatedAt: now,
          };
          yield* writeRecord(record);
          ordered.push(record);
          changes.push(upserted(record));
        }
        return { result: ordered, events: changes };
      }),
    );
  });

  const deleteWorkspace: HoustonLayoutWorkspaceService["Service"]["delete"] = Effect.fn(
    "HoustonLayoutWorkspaceService.delete",
  )(function* (input) {
    const operation = "houston.layoutWorkspaces.delete";
    return yield* transact<HoustonLayoutWorkspaceDeleteResult, HoustonLayoutWorkspaceError>(
      Effect.gen(function* () {
        const all = yield* readAll;
        const doomed = all.find((workspace) => workspace.id === input.workspaceId);
        if (doomed === undefined) return { result: { deleted: false }, events: [] };
        if (all.length === 1) {
          return yield* refuse(
            "last_workspace",
            operation,
            `Cannot delete workspace '${doomed.id}': it is the only workspace, and a layout keeps at least 1.`,
            { field: "workspaceId", limit: 1, actual: all.length },
          );
        }
        const target = all.find((workspace) => workspace.id !== doomed.id)!;
        const chatTabs = doomed.columns.flatMap((column) =>
          column.panes.flatMap((pane) => pane.tabs.filter((tab) => tab.content.kind === "chat")),
        );
        const changes: HoustonLayoutWorkspaceStreamEvent[] = [];
        if (chatTabs.length > 0) {
          const lastColumn = target.columns.at(-1);
          const lastPane = lastColumn?.panes.at(-1);
          let columns: HoustonLayoutColumn[];
          if (lastColumn === undefined || lastPane === undefined) {
            const stem = yield* random.uuidV4();
            columns = [
              ...target.columns,
              {
                id: `column:${stem}`,
                width: 1,
                panes: [
                  { id: `pane:${stem}`, size: 1, activeTabId: chatTabs[0]!.id, tabs: chatTabs },
                ],
              },
            ];
          } else {
            columns = target.columns.map((column) =>
              column.id === lastColumn.id
                ? {
                    ...column,
                    panes: column.panes.map((pane) =>
                      pane.id === lastPane.id
                        ? { ...pane, tabs: [...pane.tabs, ...chatTabs] }
                        : pane,
                    ),
                  }
                : column,
            );
          }
          const record = {
            ...target,
            columns,
            revision: target.revision + 1,
            updatedAt: yield* nowIso,
          };
          const violation = findLayoutViolation(record);
          if (violation !== undefined) {
            return yield* refuse(
              violation.kind,
              operation,
              `Cannot delete workspace '${doomed.id}': moving its ${chatTabs.length} chat tabs into workspace '${target.id}' breaks a bound. ${violation.message}`,
              {
                field: violation.field,
                ...(violation.limit === undefined ? {} : { limit: violation.limit }),
                ...(violation.actual === undefined ? {} : { actual: violation.actual }),
              },
            );
          }
          yield* writeRecord(record);
          changes.push(upserted(record));
        }
        yield* run(sql`DELETE FROM houston_layout_workspaces WHERE id = ${doomed.id}`);
        changes.push({ deleted: { workspaceId: doomed.id } });
        return { result: { deleted: true }, events: changes };
      }),
    );
  });

  const subscribe: HoustonLayoutWorkspaceService["Service"]["subscribe"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribing before the read keeps every event committed during it.
      const subscription = yield* PubSub.subscribe(events);
      const workspaces = yield* readAll;
      return Stream.concat(
        Stream.succeed<HoustonLayoutWorkspaceStreamEvent>({ snapshot: { workspaces } }),
        Stream.fromSubscription(subscription),
      );
    }),
  );

  return HoustonLayoutWorkspaceService.of({
    list,
    get,
    put,
    reorder,
    delete: deleteWorkspace,
    subscribe,
  });
});

export const layer = Layer.effect(HoustonLayoutWorkspaceService, make);
