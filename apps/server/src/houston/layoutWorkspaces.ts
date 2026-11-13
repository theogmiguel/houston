// The server's layout workspaces: one row per workspace in houston_layout_workspaces. Every
// mutation commits in one transaction, bumps the revision of each workspace it changes and then
// publishes the change. The layout holds one tab per content, and never fewer than one workspace.
import {
  HOUSTON_LAYOUT_PAGES,
  HOUSTON_LAYOUT_WORKSPACE_LIMITS,
  type HoustonLayoutColumn,
  type HoustonLayoutThreadAssignInput,
  HoustonLayoutThreadMembership,
  type HoustonLayoutThreadMoveInput,
  type HoustonLayoutThreadMoveResult,
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

import { chatContentOf, findTab, locateTab, withoutTab, withTabAppended } from "./layoutTabs.ts";
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
    /** Every thread's workspace. */
    readonly memberships: Effect.Effect<ReadonlyArray<HoustonLayoutThreadMembership>>;
    /** Records a new thread's workspace; a thread that already has one keeps it. */
    readonly assignThread: (
      input: HoustonLayoutThreadAssignInput,
    ) => Effect.Effect<HoustonLayoutThreadMembership, HoustonLayoutWorkspaceError>;
    /**
     * Gives a thread that was just created its workspace: its parent's when it has one, else the
     * workspace last reported as focused, else the first. A thread that already has one keeps it.
     */
    readonly assignCreated: (input: {
      readonly environmentId: string;
      readonly threadId: string;
      readonly parentThreadId: string | null;
      /** A subagent child, which follows its parent when the parent moves. */
      readonly follows: boolean;
    }) => Effect.Effect<HoustonLayoutThreadMembership>;
    /** Moves a thread, its children and their chat tabs to a workspace in one transaction. */
    readonly moveThread: (
      input: HoustonLayoutThreadMoveInput,
    ) => Effect.Effect<HoustonLayoutThreadMoveResult, HoustonLayoutWorkspaceError>;
    /** Forgets a deleted thread's workspace. */
    readonly removeThread: (input: {
      readonly environmentId: string;
      readonly threadId: string;
    }) => Effect.Effect<void>;
    /** Stores the workspace a client last had focused; refused when it does not exist. */
    readonly setFocus: (workspaceId: string) => Effect.Effect<void, HoustonLayoutWorkspaceError>;
    /**
     * Startup catch-up: forgets entries of threads that no longer exist and gives every other
     * listed thread without one its parent's workspace, else the first.
     */
    readonly reconcileThreads: (
      environmentId: string,
    ) => Effect.Effect<{ readonly assigned: number; readonly removed: number }>;
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

const decodeStrict = Schema.decodeUnknownOption(HoustonLayoutWorkspaceRecord);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRetiredPageTab = (tab: unknown): boolean => {
  if (!isRecord(tab) || !isRecord(tab.content) || tab.content.kind !== "page") return false;
  return !(HOUSTON_LAYOUT_PAGES as ReadonlyArray<unknown>).includes(tab.content.page);
};

/**
 * Drops the page tabs a stored layout holds for a page that no longer exists, the way closing
 * them would: a pane left without tabs and a column left without panes go, the panes that stay
 * share the column's height again, and a pane whose active tab went activates its first tab.
 * Returns the value untouched when nothing was dropped.
 */
export const dropRetiredPageTabs = (stored: unknown): unknown => {
  if (!isRecord(stored) || !Array.isArray(stored.columns)) return stored;
  let dropped = false;
  const columns = stored.columns.flatMap((column: unknown) => {
    if (!isRecord(column) || !Array.isArray(column.panes)) return [column];
    const panes = column.panes.flatMap((pane: unknown) => {
      if (!isRecord(pane) || !Array.isArray(pane.tabs)) return [pane];
      const tabs = pane.tabs.filter((tab: unknown) => !isRetiredPageTab(tab));
      if (tabs.length === pane.tabs.length) return [pane];
      dropped = true;
      if (tabs.length === 0) return [];
      const active = tabs.some((tab: unknown) => isRecord(tab) && tab.id === pane.activeTabId);
      return [
        { ...pane, tabs, activeTabId: active ? pane.activeTabId : (tabs[0] as { id: string }).id },
      ];
    });
    if (panes.length === 0) return [];
    if (panes.length === column.panes.length) return [{ ...column, panes }];
    const total = panes.reduce(
      (sum: number, pane: unknown) =>
        sum + (isRecord(pane) && typeof pane.size === "number" ? pane.size : 0),
      0,
    );
    return [
      {
        ...column,
        panes: panes.map((pane: unknown) =>
          isRecord(pane) && typeof pane.size === "number" && total > 0
            ? { ...pane, size: pane.size / total }
            : pane,
        ),
      },
    ];
  });
  return dropped ? { ...stored, columns } : stored;
};

const decodeRecord = (json: string) => {
  try {
    return decodeStrict(dropRetiredPageTabs(JSON.parse(json)));
  } catch {
    return Option.none();
  }
};
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(HoustonLayoutWorkspaceRecord));

interface MembershipRow {
  readonly environment_id: string;
  readonly thread_id: string;
  readonly workspace_id: string;
  readonly parent_thread_id: string | null;
}

const membershipOf = (row: MembershipRow): HoustonLayoutThreadMembership => ({
  environmentId: row.environment_id,
  threadId: row.thread_id,
  workspaceId: row.workspace_id,
  parentThreadId: row.parent_thread_id,
});

// Typed as a plain predicate: a stored row already has the membership's shape, not its bounds.
const isMembership: (row: HoustonLayoutThreadMembership) => boolean = Schema.is(
  HoustonLayoutThreadMembership,
);

const membershipEvent = (
  membership: HoustonLayoutThreadMembership,
): HoustonLayoutWorkspaceStreamEvent => ({ membership });

const chatKeysOf = (record: Pick<HoustonLayoutWorkspaceRecord, "columns">) =>
  new Map(
    record.columns.flatMap((column) =>
      column.panes.flatMap((pane) =>
        pane.tabs.flatMap((tab) =>
          tab.content.kind === "chat" && tab.content.target.kind === "server"
            ? [[layoutTabContentKey(tab.content), tab.content.target.threadRef] as const]
            : [],
        ),
      ),
    ),
  );

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

  const readMemberships = run(
    sql<MembershipRow>`
      SELECT environment_id, thread_id, workspace_id, parent_thread_id
      FROM houston_layout_thread_membership ORDER BY environment_id, thread_id
    `,
  ).pipe(Effect.map((rows) => rows.map(membershipOf)));

  const readMembership = (environmentId: string, threadId: string) =>
    run(
      sql<MembershipRow>`
        SELECT environment_id, thread_id, workspace_id, parent_thread_id
        FROM houston_layout_thread_membership
        WHERE environment_id = ${environmentId} AND thread_id = ${threadId}
      `,
    ).pipe(Effect.map((rows) => (rows[0] === undefined ? null : membershipOf(rows[0]))));

  const writeMembership = (membership: HoustonLayoutThreadMembership) =>
    run(sql`
      INSERT INTO houston_layout_thread_membership
        (environment_id, thread_id, workspace_id, parent_thread_id)
      VALUES (${membership.environmentId}, ${membership.threadId}, ${membership.workspaceId},
              ${membership.parentThreadId})
      ON CONFLICT (environment_id, thread_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        parent_thread_id = excluded.parent_thread_id
    `);

  const readChildren = (environmentId: string, threadId: string) =>
    run(
      sql<MembershipRow>`
        SELECT environment_id, thread_id, workspace_id, parent_thread_id
        FROM houston_layout_thread_membership
        WHERE environment_id = ${environmentId} AND parent_thread_id = ${threadId}
      `,
    ).pipe(Effect.map((rows) => rows.map(membershipOf)));

  /** The workspace last reported as focused, else the first; undefined only with no workspace. */
  const defaultWorkspaceId = Effect.gen(function* () {
    const all = yield* readAll;
    const hint = yield* run(
      sql<{
        readonly workspace_id: string;
      }>`SELECT workspace_id FROM houston_layout_focus WHERE id = 1`,
    );
    const hinted = hint[0]?.workspace_id;
    if (hinted !== undefined && all.some((workspace) => workspace.id === hinted)) return hinted;
    return all[0]?.id;
  });

  /** Moves entries that name a missing workspace to the first one. */
  const repairMemberships = Effect.gen(function* () {
    const all = yield* readAll;
    const first = all[0];
    if (first === undefined) return [] as HoustonLayoutWorkspaceStreamEvent[];
    const known = new Set(all.map((workspace) => workspace.id));
    const changes: HoustonLayoutWorkspaceStreamEvent[] = [];
    for (const row of yield* readMemberships) {
      if (known.has(row.workspaceId)) continue;
      const repaired = { ...row, workspaceId: first.id };
      yield* writeMembership(repaired);
      changes.push(membershipEvent(repaired));
    }
    return changes;
  });

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

  /**
   * A thread's chat opened in a workspace makes that workspace the thread's own, so a tab moved
   * between workspaces by any path moves the membership with it. A subagent child follows its
   * parent and keeps its entry.
   */
  const adoptTabMemberships = Effect.fn("HoustonLayoutWorkspaceService.adoptTabMemberships")(
    function* (
      record: HoustonLayoutWorkspaceRecord,
      before: HoustonLayoutWorkspaceRecord | undefined,
    ) {
      const previous = before === undefined ? new Map() : chatKeysOf(before);
      const changes: HoustonLayoutWorkspaceStreamEvent[] = [];
      for (const [key, ref] of chatKeysOf(record)) {
        if (previous.has(key)) continue;
        const row = yield* readMembership(ref.environmentId, ref.threadId);
        if (row !== null && (row.parentThreadId !== null || row.workspaceId === record.id))
          continue;
        const moved = { ...ref, workspaceId: record.id, parentThreadId: null };
        yield* writeMembership(moved);
        changes.push(membershipEvent(moved));
        for (const child of yield* readChildren(ref.environmentId, ref.threadId)) {
          const followed = { ...child, workspaceId: record.id };
          yield* writeMembership(followed);
          changes.push(membershipEvent(followed));
        }
      }
      return changes;
    },
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
          const adopted = yield* adoptTabMemberships(record, undefined);
          return {
            result: { status: "saved", workspace: record } as const,
            events: [upserted(record), ...adopted],
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
        const adopted = yield* adoptTabMemberships(record, current);
        return {
          result: { status: "saved", workspace: record } as const,
          events: [upserted(record), ...adopted],
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
        const changes: HoustonLayoutWorkspaceStreamEvent[] = [];
        const members = (yield* readMemberships).filter((row) => row.workspaceId === doomed.id);
        const live: string[] = [];
        const forgotten = new Set<string>();
        const orphaned: HoustonLayoutThreadMembership[] = [];
        for (const member of members) {
          const rows = yield* run(
            sql<{ readonly deleted_at: string | null }>`
              SELECT deleted_at FROM orchestration_v2_projection_threads
              WHERE thread_id = ${member.threadId}
            `,
          );
          if (rows[0] === undefined) {
            // No thread row yet: the entry is a pre-assignment, so its tab and entry move on.
            if (member.parentThreadId === null) orphaned.push(member);
            continue;
          }
          if (rows[0].deleted_at === null) {
            live.push(member.threadId);
            continue;
          }
          forgotten.add(member.threadId);
        }
        if (live.length > 0) {
          return yield* refuse(
            "has_threads",
            operation,
            `Cannot delete workspace '${doomed.id}' ("${doomed.name}"): ${live.length} threads still belong to it (${live.slice(0, 5).join(", ")}${live.length > 5 ? ", …" : ""}); delete them first.`,
            { field: "workspaceId", limit: 0, actual: live.length },
          );
        }
        for (const member of members) {
          if (orphaned.includes(member)) {
            const moved = { ...member, workspaceId: target.id };
            yield* writeMembership(moved);
            changes.push(membershipEvent(moved));
            continue;
          }
          yield* run(
            sql`DELETE FROM houston_layout_thread_membership WHERE environment_id = ${member.environmentId} AND thread_id = ${member.threadId}`,
          );
          changes.push({
            membershipRemoved: { environmentId: member.environmentId, threadId: member.threadId },
          });
        }
        const chatTabs = doomed.columns.flatMap((column) =>
          column.panes.flatMap((pane) =>
            pane.tabs.filter(
              (tab) =>
                tab.content.kind === "chat" &&
                !(
                  tab.content.target.kind === "server" &&
                  forgotten.has(tab.content.target.threadRef.threadId)
                ),
            ),
          ),
        );
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

  const memberships: HoustonLayoutWorkspaceService["Service"]["memberships"] = readMemberships;

  const requireWorkspace = (operation: string, workspaceId: string) =>
    readOne(workspaceId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              refuse("not_found", operation, `no workspace '${workspaceId}'`, {
                field: "workspaceId",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const assignThread: HoustonLayoutWorkspaceService["Service"]["assignThread"] = Effect.fn(
    "HoustonLayoutWorkspaceService.assignThread",
  )(function* (input) {
    const operation = "houston.layoutWorkspaces.assignThread";
    return yield* transact<HoustonLayoutThreadMembership, HoustonLayoutWorkspaceError>(
      Effect.gen(function* () {
        yield* requireWorkspace(operation, input.workspaceId);
        const existing = yield* readMembership(input.environmentId, input.threadId);
        if (existing !== null) return { result: existing, events: [] };
        const created = { ...input, parentThreadId: null };
        yield* writeMembership(created);
        return { result: created, events: [membershipEvent(created)] };
      }),
    );
  });

  const assignCreated: HoustonLayoutWorkspaceService["Service"]["assignCreated"] = (input) =>
    transact<HoustonLayoutThreadMembership, never>(
      Effect.gen(function* () {
        const existing = yield* readMembership(input.environmentId, input.threadId);
        if (existing !== null) return { result: existing, events: [] };
        const parent =
          input.parentThreadId === null
            ? null
            : yield* readMembership(input.environmentId, input.parentThreadId);
        const workspaceId = parent?.workspaceId ?? (yield* defaultWorkspaceId);
        if (workspaceId === undefined) {
          // A layout always keeps one workspace; without one there is nothing to assign yet.
          return {
            result: {
              environmentId: input.environmentId,
              threadId: input.threadId,
              workspaceId: "",
              parentThreadId: null,
            },
            events: [],
          };
        }
        const created = {
          environmentId: input.environmentId,
          threadId: input.threadId,
          workspaceId,
          parentThreadId: input.follows ? input.parentThreadId : null,
        };
        yield* writeMembership(created);
        return { result: created, events: [membershipEvent(created)] };
      }),
    );

  const moveThread: HoustonLayoutWorkspaceService["Service"]["moveThread"] = Effect.fn(
    "HoustonLayoutWorkspaceService.moveThread",
  )(function* (input) {
    const operation = "houston.layoutWorkspaces.moveThread";
    return yield* transact<HoustonLayoutThreadMoveResult, HoustonLayoutWorkspaceError>(
      Effect.gen(function* () {
        const all = yield* readAll;
        const target = all.find((workspace) => workspace.id === input.workspaceId);
        if (target === undefined) {
          return yield* refuse("not_found", operation, `no workspace '${input.workspaceId}'`, {
            field: "workspaceId",
          });
        }
        const current = yield* readMembership(input.environmentId, input.threadId);
        if (current?.parentThreadId !== null && current?.parentThreadId !== undefined) {
          return yield* refuse(
            "invalid",
            operation,
            `Thread '${input.threadId}' is a child of thread '${current.parentThreadId}' and follows it; move thread '${current.parentThreadId}' instead.`,
            { field: "threadId" },
          );
        }
        const children = yield* readChildren(input.environmentId, input.threadId);
        const threadIds = [input.threadId, ...children.map((child) => child.threadId)];
        const working = new Map(all.map((workspace) => [workspace.id, workspace] as const));
        const changed = new Set<string>();
        const rootKey = layoutTabContentKey(chatContentOf(input.environmentId, input.threadId));
        const rootHolder = all.find((workspace) => findTab(workspace, rootKey) !== undefined);
        const located = rootHolder === undefined ? undefined : locateTab(rootHolder, rootKey);
        const previous = {
          workspaceId: current?.workspaceId ?? rootHolder?.id ?? null,
          paneId: located?.paneId ?? null,
          index: located?.index ?? null,
        };
        for (const [position, threadId] of threadIds.entries()) {
          const key = layoutTabContentKey(chatContentOf(input.environmentId, threadId));
          const holders = [...working.values()].filter(
            (workspace) => workspace.id !== target.id && findTab(workspace, key) !== undefined,
          );
          if (holders.length === 0) continue;
          const tab = findTab(holders[0]!, key)!;
          for (const holder of holders) {
            working.set(holder.id, withoutTab(working.get(holder.id)!, key));
            changed.add(holder.id);
          }
          const inTarget = working.get(target.id)!;
          if (findTab(inTarget, key) !== undefined) continue;
          const stem = yield* random.uuidV4();
          working.set(
            target.id,
            withTabAppended(
              inTarget,
              tab,
              stem,
              position === 0 && input.paneId !== undefined
                ? { paneId: input.paneId, index: input.index }
                : undefined,
            ),
          );
          changed.add(target.id);
        }
        const now = yield* nowIso;
        const changes: HoustonLayoutWorkspaceStreamEvent[] = [];
        for (const id of changed) {
          const next = working.get(id)!;
          const violation = findLayoutViolation(next);
          if (violation !== undefined) {
            return yield* refuse(
              violation.kind,
              operation,
              `Cannot move thread '${input.threadId}' to workspace '${target.id}': ${violation.message}`,
              {
                field: violation.field,
                ...(violation.limit === undefined ? {} : { limit: violation.limit }),
                ...(violation.actual === undefined ? {} : { actual: violation.actual }),
              },
            );
          }
          const record = { ...next, revision: next.revision + 1, updatedAt: now };
          yield* writeRecord(record);
          changes.push(upserted(record));
        }
        let moved: HoustonLayoutThreadMembership = {
          environmentId: input.environmentId,
          threadId: input.threadId,
          workspaceId: target.id,
          parentThreadId: null,
        };
        yield* writeMembership(moved);
        if (current?.workspaceId !== target.id || current === null) {
          changes.push(membershipEvent(moved));
        }
        for (const child of children) {
          if (child.workspaceId === target.id) continue;
          const followed = { ...child, workspaceId: target.id };
          yield* writeMembership(followed);
          changes.push(membershipEvent(followed));
        }
        moved = { ...moved };
        return { result: { membership: moved, previous }, events: changes };
      }),
    );
  });

  const removeThread: HoustonLayoutWorkspaceService["Service"]["removeThread"] = (input) =>
    transact<void, never>(
      Effect.gen(function* () {
        const existing = yield* readMembership(input.environmentId, input.threadId);
        if (existing === null) return { result: undefined, events: [] };
        yield* run(
          sql`DELETE FROM houston_layout_thread_membership WHERE environment_id = ${input.environmentId} AND thread_id = ${input.threadId}`,
        );
        return {
          result: undefined,
          events: [
            {
              membershipRemoved: {
                environmentId: input.environmentId,
                threadId: input.threadId,
              },
            },
          ],
        };
      }),
    );

  const setFocus: HoustonLayoutWorkspaceService["Service"]["setFocus"] = Effect.fn(
    "HoustonLayoutWorkspaceService.setFocus",
  )(function* (workspaceId) {
    const operation = "houston.layoutWorkspaces.setFocus";
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        yield* requireWorkspace(operation, workspaceId);
        const now = yield* nowIso;
        yield* run(sql`
          INSERT INTO houston_layout_focus (id, workspace_id, updated_at)
          VALUES (1, ${workspaceId}, ${now})
          ON CONFLICT (id) DO UPDATE SET
            workspace_id = excluded.workspace_id, updated_at = excluded.updated_at
        `);
      }),
    );
  });

  const reconcileThreads: HoustonLayoutWorkspaceService["Service"]["reconcileThreads"] = (
    environmentId,
  ) =>
    transact<{ assigned: number; removed: number }, never>(
      Effect.gen(function* () {
        const threads = yield* run(
          sql<{ readonly thread_id: string; readonly payload_json: string }>`
            SELECT thread_id, payload_json FROM orchestration_v2_projection_threads
            WHERE deleted_at IS NULL
          `,
        );
        const alive = new Set(threads.map((row) => row.thread_id));
        const changes: HoustonLayoutWorkspaceStreamEvent[] = [];
        let removed = 0;
        for (const row of yield* readMemberships) {
          if (row.environmentId !== environmentId || alive.has(row.threadId)) continue;
          yield* run(
            sql`DELETE FROM houston_layout_thread_membership WHERE environment_id = ${row.environmentId} AND thread_id = ${row.threadId}`,
          );
          changes.push({
            membershipRemoved: { environmentId: row.environmentId, threadId: row.threadId },
          });
          removed += 1;
        }
        const first = (yield* readAll)[0];
        let assigned = 0;
        if (first !== undefined) {
          const parsed = threads.flatMap((row) => {
            try {
              const thread = JSON.parse(row.payload_json) as {
                lineage?: {
                  parentThreadId?: string | null;
                  relationshipToParent?: string | null;
                  sideChat?: boolean;
                };
                side?: unknown;
              };
              if (thread.lineage?.sideChat === true || thread.side !== undefined) return [];
              return [
                {
                  threadId: row.thread_id,
                  parent: thread.lineage?.parentThreadId ?? null,
                  follows: thread.lineage?.relationshipToParent === "subagent",
                },
              ];
            } catch {
              return [];
            }
          });
          // Parents first, so a child finds its parent's workspace.
          const ordered = [
            ...parsed.filter((thread) => thread.parent === null),
            ...parsed.filter((thread) => thread.parent !== null),
          ];
          for (const thread of ordered) {
            if ((yield* readMembership(environmentId, thread.threadId)) !== null) continue;
            const parent =
              thread.parent === null ? null : yield* readMembership(environmentId, thread.parent);
            const created = {
              environmentId,
              threadId: thread.threadId,
              workspaceId: parent?.workspaceId ?? first.id,
              parentThreadId: thread.follows ? thread.parent : null,
            };
            yield* writeMembership(created);
            changes.push(membershipEvent(created));
            assigned += 1;
          }
        }
        return { result: { assigned, removed }, events: changes };
      }),
    );

  const repair = transact<void, never>(
    repairMemberships.pipe(Effect.map((changes) => ({ result: undefined, events: changes }))),
  );

  const subscribe: HoustonLayoutWorkspaceService["Service"]["subscribe"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribing before the read keeps every event committed during it.
      const subscription = yield* PubSub.subscribe(events);
      yield* repair;
      const workspaces = yield* readAll;
      // One entry the contract refuses would fail the whole snapshot and leave the window empty.
      const stored = yield* readMemberships;
      const threadMemberships = stored.filter((row) => isMembership(row));
      if (threadMemberships.length < stored.length) {
        yield* Effect.logWarning(
          "Houston layout workspaces: left thread memberships the contract refuses out of the snapshot.",
          {
            skipped: stored.length - threadMemberships.length,
            threadIds: stored.filter((row) => !isMembership(row)).map((row) => row.threadId),
          },
        );
      }
      return Stream.concat(
        Stream.succeed<HoustonLayoutWorkspaceStreamEvent>({
          snapshot: { workspaces, memberships: threadMemberships },
        }),
        Stream.fromSubscription(subscription),
      );
    }),
  );

  yield* repair;

  return HoustonLayoutWorkspaceService.of({
    memberships,
    assignThread,
    assignCreated,
    moveThread,
    removeThread,
    setFocus,
    reconcileThreads,
    list,
    get,
    put,
    reorder,
    delete: deleteWorkspace,
    subscribe,
  });
});

export const layer = Layer.effect(HoustonLayoutWorkspaceService, make);
