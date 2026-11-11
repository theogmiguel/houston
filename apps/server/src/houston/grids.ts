// The server's grids: one row per grid in houston_grids, changed only through the shared grid
// domain so the renderer and the agent tools lay a grid out the same way. Every mutation commits
// in one transaction, bumps the grid's revision and then publishes its change event.
import type { ProjectId } from "@houston-app/contracts";
import {
  HOUSTON_GRID_LIMITS,
  HoustonGridError,
  type HoustonGridCreateInput,
  type HoustonGridDeleteInput,
  type HoustonGridDeleteResult,
  type HoustonGridErrorKind,
  type HoustonGridListInput,
  type HoustonGridPlaceThreadInput,
  type HoustonGridPutInput,
  type HoustonGridPutResult,
  HoustonGridRecord,
  type HoustonGridRemoveThreadInput,
  type HoustonGridRenameInput,
  type HoustonGridSetHiddenInput,
  type HoustonGridSetPinnedInput,
  type HoustonGridStreamEvent,
} from "@houston-app/contracts/houston/grids";
import {
  type GridRecord,
  containsThreadId,
  createGridRecord,
  defaultFocus,
  moveThreadToGridRecords,
  pinGridRecord,
  removeThreadFromGridRecord,
  renameGridRecord,
  setGridHiddenRecord,
  unpinGridRecord,
  workspaceKeyOf,
} from "@houston-app/shared/grid/record";
import { preorderThreads } from "@houston-app/shared/grid/tree";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { nowIso } from "./tasks/TaskStore.ts";

export class HoustonGridService extends Context.Service<
  HoustonGridService,
  {
    readonly list: (
      input: HoustonGridListInput,
    ) => Effect.Effect<ReadonlyArray<HoustonGridRecord>, HoustonGridError>;
    readonly get: (gridId: string) => Effect.Effect<HoustonGridRecord, HoustonGridError>;
    /** Saves a whole grid when `expectedRevision` is the stored revision; otherwise returns the stored one. */
    readonly put: (
      input: HoustonGridPutInput,
    ) => Effect.Effect<HoustonGridPutResult, HoustonGridError>;
    readonly create: (
      input: HoustonGridCreateInput,
    ) => Effect.Effect<HoustonGridRecord, HoustonGridError>;
    readonly rename: (
      input: HoustonGridRenameInput,
    ) => Effect.Effect<HoustonGridRecord, HoustonGridError>;
    readonly delete: (
      input: HoustonGridDeleteInput,
    ) => Effect.Effect<HoustonGridDeleteResult, HoustonGridError>;
    readonly setHidden: (
      input: HoustonGridSetHiddenInput,
    ) => Effect.Effect<HoustonGridRecord, HoustonGridError>;
    readonly setPinned: (
      input: HoustonGridSetPinnedInput,
    ) => Effect.Effect<HoustonGridRecord, HoustonGridError>;
    /** Appends the thread and takes it out of any other grid of its project. */
    readonly placeThread: (
      input: HoustonGridPlaceThreadInput,
    ) => Effect.Effect<HoustonGridRecord, HoustonGridError>;
    readonly removeThread: (
      input: HoustonGridRemoveThreadInput,
    ) => Effect.Effect<HoustonGridRecord, HoustonGridError>;
    readonly subscribe: Stream.Stream<HoustonGridStreamEvent, HoustonGridError>;
    /** Drops the grids of projects that no longer exist; a deleted project leaves its grids behind. */
    readonly sweepOrphans: Effect.Effect<void>;
  }
>()("@houston-app/cli/houston/grids/HoustonGridService") {}

const refuse = (
  kind: HoustonGridErrorKind,
  operation: string,
  message: string,
  detail: { field?: string; limit?: number; actual?: number } = {},
) => new HoustonGridError({ kind, operation, message, ...detail });

interface GridRow {
  readonly record_json: string;
}

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(HoustonGridRecord));
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(HoustonGridRecord));

// The shared domain keeps focus on the grid; the server stores none, so it is derived.
const toDomain = (record: HoustonGridRecord): GridRecord => ({
  id: record.id,
  name: record.name,
  environmentId: record.environmentId,
  projectId: record.projectId,
  workspaceKey: record.workspaceKey,
  tree: record.tree,
  focusedThreadId: defaultFocus(record.tree),
  pinnedAt: record.pinnedAt,
  hidden: record.hidden,
  createdAt: record.createdAt,
});

const upserted = (record: HoustonGridRecord): HoustonGridStreamEvent => ({ upserted: record });

const sameContent = (left: HoustonGridRecord, right: HoustonGridRecord) =>
  encodeRecord({ ...left, revision: 0, updatedAt: "" }) ===
  encodeRecord({ ...right, revision: 0, updatedAt: "" });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const random = yield* SecureRandom.SecureRandom;
  const events = yield* PubSub.unbounded<HoustonGridStreamEvent>();
  const lock = yield* Semaphore.make(1);
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);

  const parseRows = (rows: ReadonlyArray<GridRow>) =>
    Effect.forEach(rows, (row) =>
      Option.match(decodeRecord(row.record_json), {
        onSome: (record) => Effect.succeed([record]),
        onNone: () =>
          Effect.logWarning("Houston grids: skipped a stored grid that no longer decodes.").pipe(
            Effect.as([] as HoustonGridRecord[]),
          ),
      }),
    ).pipe(Effect.map((groups) => groups.flat()));

  const readAll = run(
    sql<GridRow>`SELECT record_json FROM houston_grids ORDER BY created_at, id`,
  ).pipe(Effect.flatMap(parseRows));

  const readProject = (projectId: string) =>
    run(
      sql<GridRow>`
        SELECT record_json FROM houston_grids WHERE project_id = ${projectId}
        ORDER BY created_at, id
      `,
    ).pipe(Effect.flatMap(parseRows));

  const readOne = (gridId: string) =>
    run(sql<GridRow>`SELECT record_json FROM houston_grids WHERE id = ${gridId}`).pipe(
      Effect.flatMap(parseRows),
      Effect.map((records) => Option.fromNullishOr(records[0])),
    );

  const require = (operation: string, gridId: string) =>
    readOne(gridId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(refuse("not_found", operation, `no grid ${gridId}`, { field: "gridId" })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const requireProject = (operation: string, projectId: string) =>
    projects.get(projectId as ProjectId).pipe(
      Effect.orDie,
      Effect.flatMap((project) =>
        Option.isSome(project) && project.value.deletedAt === null
          ? Effect.void
          : Effect.fail(
              refuse("not_found", operation, `no project ${projectId}`, { field: "projectId" }),
            ),
      ),
    );

  const threadProjects = (threadIds: ReadonlyArray<string>) =>
    Effect.forEach(threadIds, (threadId) =>
      run(
        sql<{ readonly project_id: string | null }>`
          SELECT project_id FROM houston_thread_shell WHERE thread_id = ${threadId} AND deleted = 0
        `,
      ).pipe(Effect.map((rows) => [threadId, rows[0]?.project_id ?? null] as const)),
    );

  /** Every thread in `threadIds` must exist and belong to `projectId`. */
  const requireThreadsIn = (
    operation: string,
    projectId: string,
    threadIds: ReadonlyArray<string>,
  ) =>
    threadProjects(threadIds).pipe(
      Effect.flatMap((owners) => {
        const missing = owners.find(([, owner]) => owner === null);
        if (missing !== undefined) {
          return Effect.fail(
            refuse("not_found", operation, `no thread ${missing[0]}`, { field: "threadId" }),
          );
        }
        const foreign = owners.find(([, owner]) => owner !== projectId);
        return foreign === undefined
          ? Effect.void
          : Effect.fail(
              refuse(
                "cross_project",
                operation,
                `thread ${foreign[0]} belongs to project ${foreign[1]}, not project ${projectId}; a grid only shows its own project's threads`,
                { field: "threadId" },
              ),
            );
      }),
    );

  const writeRecord = (record: HoustonGridRecord) =>
    run(sql`
      INSERT INTO houston_grids (id, project_id, record_json, revision, created_at, updated_at)
      VALUES (${record.id}, ${record.projectId}, ${encodeRecord(record)}, ${record.revision},
              ${record.createdAt}, ${record.updatedAt})
      ON CONFLICT (id) DO UPDATE SET
        record_json = excluded.record_json,
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `);

  /** Runs `body` in a transaction under the lock, then publishes what it returned. */
  const transact = <A, E>(
    body: Effect.Effect<
      { readonly result: A; readonly events: ReadonlyArray<HoustonGridStreamEvent> },
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

  const saveChanged = Effect.fn("HoustonGridService.saveChanged")(function* (
    previous: ReadonlyArray<HoustonGridRecord>,
    next: ReadonlyArray<GridRecord>,
    now: string,
  ) {
    const saved: HoustonGridRecord[] = [];
    for (const grid of next) {
      const before = previous.find((record) => record.id === grid.id);
      if (before === undefined) continue;
      const candidate: HoustonGridRecord = {
        ...before,
        name: grid.name,
        tree: grid.tree,
        pinnedAt: grid.pinnedAt,
        hidden: grid.hidden,
      };
      if (sameContent(before, candidate)) continue;
      const record = { ...candidate, revision: before.revision + 1, updatedAt: now };
      yield* writeRecord(record);
      saved.push(record);
    }
    return saved;
  });

  /** Applies one domain change to one grid of a project and saves every grid it touched. */
  const changeProject = <E>(
    operation: string,
    gridId: string,
    change: (
      grids: GridRecord[],
      target: HoustonGridRecord,
    ) => Effect.Effect<GridRecord[], HoustonGridError | E>,
  ) =>
    transact(
      Effect.gen(function* () {
        const target = yield* require(operation, gridId);
        const siblings = yield* readProject(target.projectId);
        const next = yield* change(siblings.map(toDomain), target);
        const saved = yield* saveChanged(siblings, next, yield* nowIso);
        return {
          result: saved.find((record) => record.id === gridId) ?? target,
          events: saved.map(upserted),
        };
      }),
    );

  const list: HoustonGridService["Service"]["list"] = Effect.fn("HoustonGridService.list")(
    function* (input) {
      return input.projectId === undefined ? yield* readAll : yield* readProject(input.projectId);
    },
  );

  const get: HoustonGridService["Service"]["get"] = (gridId) =>
    require("houston.grids.get", gridId);

  const checkName = (operation: string, name: string) =>
    name.trim().length > HOUSTON_GRID_LIMITS.nameChars
      ? Effect.fail(
          refuse(
            "limit",
            operation,
            `A grid name holds at most ${HOUSTON_GRID_LIMITS.nameChars} characters, got ${name.trim().length}.`,
            { field: "name", limit: HOUSTON_GRID_LIMITS.nameChars, actual: name.trim().length },
          ),
        )
      : Effect.void;

  const gridCap = (operation: string, projectId: string, count: number) =>
    count >= HOUSTON_GRID_LIMITS.gridsPerProject
      ? Effect.fail(
          refuse(
            "limit",
            operation,
            `Cannot create a grid in project ${projectId}: it already has ${count} grids, the limit is ${HOUSTON_GRID_LIMITS.gridsPerProject}, and the request adds 1 more.`,
            { field: "projectId", limit: HOUSTON_GRID_LIMITS.gridsPerProject, actual: count },
          ),
        )
      : Effect.void;

  const create: HoustonGridService["Service"]["create"] = Effect.fn("HoustonGridService.create")(
    function* (input) {
      const operation = "houston.grids.create";
      yield* checkName(operation, input.name ?? "");
      yield* requireProject(operation, input.projectId);
      const environmentId = yield* identity.getEnvironmentId;
      return yield* transact(
        Effect.gen(function* () {
          const siblings = yield* readProject(input.projectId);
          yield* gridCap(operation, input.projectId, siblings.length);
          // Grids list by creation time; a grid made in the same millisecond as its sibling
          // takes the next one so creation order survives the tie.
          const clock = yield* nowIso;
          const latest = siblings.reduce(
            (max, grid) => (grid.createdAt > max ? grid.createdAt : max),
            "",
          );
          const now =
            clock > latest
              ? clock
              : DateTime.formatIso(DateTime.makeUnsafe(Date.parse(latest) + 1));
          const domain = createGridRecord(siblings.map(toDomain), {
            id: yield* random.uuidV4(),
            now,
            environmentId,
            projectId: input.projectId,
            workspaceKey: workspaceKeyOf(environmentId, input.projectId),
            ...(input.name === undefined ? {} : { name: input.name }),
          });
          const record: HoustonGridRecord = {
            id: domain.id,
            environmentId,
            projectId: domain.projectId,
            workspaceKey: domain.workspaceKey,
            name: domain.name,
            tree: null,
            pinnedAt: null,
            hidden: false,
            createdAt: now,
            revision: 1,
            updatedAt: now,
          };
          yield* writeRecord(record);
          return { result: record, events: [upserted(record)] };
        }),
      );
    },
  );

  const put: HoustonGridService["Service"]["put"] = Effect.fn("HoustonGridService.put")(
    function* (input) {
      const operation = "houston.grids.put";
      const incoming = input.grid;
      const environmentId = yield* identity.getEnvironmentId;
      if (incoming.environmentId !== environmentId) {
        return yield* refuse(
          "invalid",
          operation,
          `Grid ${incoming.id} is for environment ${incoming.environmentId}; this server is environment ${environmentId}.`,
          { field: "environmentId" },
        );
      }
      const expectedKey = workspaceKeyOf(incoming.environmentId, incoming.projectId);
      if (incoming.workspaceKey !== expectedKey) {
        return yield* refuse(
          "invalid",
          operation,
          `Grid ${incoming.id} has workspaceKey ${incoming.workspaceKey}; expected ${expectedKey}.`,
          { field: "workspaceKey" },
        );
      }
      yield* requireThreadsIn(
        operation,
        incoming.projectId,
        incoming.tree === null ? [] : preorderThreads(incoming.tree).map((leaf) => leaf.threadId),
      );
      return yield* transact<HoustonGridPutResult, HoustonGridError>(
        Effect.gen(function* () {
          const existing = yield* readOne(incoming.id);
          if (Option.isNone(existing)) {
            if (input.expectedRevision !== 0) {
              return { result: { status: "conflict", current: null } as const, events: [] };
            }
            yield* requireProject(operation, incoming.projectId);
            yield* gridCap(
              operation,
              incoming.projectId,
              (yield* readProject(incoming.projectId)).length,
            );
            const now = yield* nowIso;
            const record = { ...incoming, revision: 1, createdAt: now, updatedAt: now };
            yield* writeRecord(record);
            return {
              result: { status: "saved", grid: record } as const,
              events: [upserted(record)],
            };
          }
          const current = existing.value;
          if (current.revision !== input.expectedRevision) {
            return { result: { status: "conflict", current } as const, events: [] };
          }
          if (current.projectId !== incoming.projectId) {
            return yield* refuse(
              "invalid",
              operation,
              `Grid ${incoming.id} belongs to project ${current.projectId}; a grid cannot move to project ${incoming.projectId}.`,
              { field: "projectId" },
            );
          }
          const candidate: HoustonGridRecord = { ...incoming, createdAt: current.createdAt };
          if (sameContent(current, candidate)) {
            return { result: { status: "saved", grid: current } as const, events: [] };
          }
          const record = {
            ...candidate,
            revision: current.revision + 1,
            updatedAt: yield* nowIso,
          };
          yield* writeRecord(record);
          return {
            result: { status: "saved", grid: record } as const,
            events: [upserted(record)],
          };
        }),
      );
    },
  );

  const rename: HoustonGridService["Service"]["rename"] = Effect.fn("HoustonGridService.rename")(
    function* (input) {
      const operation = "houston.grids.rename";
      if (input.name.trim().length === 0) {
        return yield* refuse(
          "invalid",
          operation,
          `A grid name cannot be blank, got '${input.name}' for grid ${input.gridId}.`,
          { field: "name" },
        );
      }
      yield* checkName(operation, input.name);
      return yield* changeProject(operation, input.gridId, (grids) =>
        Effect.succeed(
          grids.map((grid) =>
            grid.id === input.gridId ? renameGridRecord(grid, input.name) : grid,
          ),
        ),
      );
    },
  );

  const setHidden: HoustonGridService["Service"]["setHidden"] = (input) =>
    changeProject("houston.grids.setHidden", input.gridId, (grids) =>
      Effect.succeed(
        grids.map((grid) =>
          grid.id === input.gridId ? setGridHiddenRecord(grid, input.hidden) : grid,
        ),
      ),
    );

  const setPinned: HoustonGridService["Service"]["setPinned"] = (input) =>
    Effect.flatMap(nowIso, (now) =>
      changeProject("houston.grids.setPinned", input.gridId, (grids) =>
        Effect.succeed(
          grids.map((grid) =>
            grid.id === input.gridId
              ? input.pinned
                ? pinGridRecord(grid, now)
                : unpinGridRecord(grid)
              : grid,
          ),
        ),
      ),
    );

  const placeThread: HoustonGridService["Service"]["placeThread"] = Effect.fn(
    "HoustonGridService.placeThread",
  )(function* (input) {
    const operation = "houston.grids.placeThread";
    const target = yield* require(operation, input.gridId);
    yield* requireThreadsIn(operation, target.projectId, [input.threadId]);
    return yield* changeProject(operation, input.gridId, (grids, current) => {
      const placed = moveThreadToGridRecords(grids, {
        threadId: input.threadId,
        threadEnvironmentId: current.environmentId,
        threadProjectId: current.projectId,
        targetGridId: input.gridId,
      });
      if (placed.ok) return Effect.succeed(placed.grids);
      return Effect.fail(
        placed.reason === "grid_full"
          ? refuse(
              "grid_full",
              operation,
              `Cannot add thread ${input.threadId} to grid ${placed.gridId}: it already shows ${placed.threadCount} threads, the limit is ${placed.limit}.`,
              { field: "gridId", limit: placed.limit, actual: placed.threadCount },
            )
          : refuse("not_found", operation, `no grid ${input.gridId}`, { field: "gridId" }),
      );
    });
  });

  const removeThread: HoustonGridService["Service"]["removeThread"] = (input) =>
    changeProject("houston.grids.removeThread", input.gridId, (grids) => {
      const grid = grids.find((entry) => entry.id === input.gridId);
      if (grid === undefined || !containsThreadId(grid.tree, input.threadId)) {
        return Effect.fail(
          refuse(
            "not_found",
            "houston.grids.removeThread",
            `thread ${input.threadId} is not in grid ${input.gridId}`,
            { field: "threadId" },
          ),
        );
      }
      return Effect.succeed(
        grids.map((entry) =>
          entry.id === input.gridId ? removeThreadFromGridRecord(entry, input.threadId) : entry,
        ),
      );
    });

  const deleteGrid: HoustonGridService["Service"]["delete"] = (input) =>
    transact<HoustonGridDeleteResult, never>(
      Effect.gen(function* () {
        const existing = yield* readOne(input.gridId);
        if (Option.isNone(existing)) return { result: { deleted: false }, events: [] };
        yield* run(sql`DELETE FROM houston_grids WHERE id = ${input.gridId}`);
        return {
          result: { deleted: true },
          events: [
            { deleted: { gridId: input.gridId, projectId: existing.value.projectId } },
          ] as HoustonGridStreamEvent[],
        };
      }),
    );

  const sweepOrphans: HoustonGridService["Service"]["sweepOrphans"] = transact(
    Effect.gen(function* () {
      const grids = yield* readAll;
      const orphans: HoustonGridRecord[] = [];
      for (const projectId of new Set(grids.map((grid) => grid.projectId))) {
        const project = yield* projects.get(projectId as ProjectId).pipe(Effect.orDie);
        if (Option.isNone(project) || project.value.deletedAt !== null) {
          orphans.push(...grids.filter((grid) => grid.projectId === projectId));
        }
      }
      for (const grid of orphans) yield* run(sql`DELETE FROM houston_grids WHERE id = ${grid.id}`);
      return {
        result: undefined,
        events: orphans.map((grid): HoustonGridStreamEvent => ({
          deleted: { gridId: grid.id, projectId: grid.projectId },
        })),
      };
    }),
  );

  const subscribe: HoustonGridService["Service"]["subscribe"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribing before the read keeps every event committed during it.
      const subscription = yield* PubSub.subscribe(events);
      const grids = yield* readAll;
      return Stream.concat(
        Stream.succeed<HoustonGridStreamEvent>({ snapshot: { grids } }),
        Stream.fromSubscription(subscription),
      );
    }),
  );

  return HoustonGridService.of({
    list,
    get,
    put,
    create,
    rename,
    delete: deleteGrid,
    setHidden,
    setPinned,
    placeThread,
    removeThread,
    subscribe,
    sweepOrphans,
  });
});

export const layer = Layer.effect(HoustonGridService, make);

/** At startup, drops the grids of projects deleted while the server was not running. */
export const sweep = Effect.gen(function* () {
  const service = yield* HoustonGridService;
  yield* service.sweepOrphans;
});
