// The layout workspace service over an in-memory database: revisions, the one-tab-per-content
// rule, the last-workspace rule, chat tabs moving on delete, reordering, limits and the stream.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  HOUSTON_LAYOUT_WORKSPACE_LIMITS as LIMITS,
  type HoustonLayoutColumn,
  type HoustonLayoutTabContent,
  type HoustonLayoutWorkspaceError,
  type HoustonLayoutWorkspaceRecord,
} from "@houston-app/contracts/houston/layoutWorkspaces";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as HoustonLayoutWorkspaces from "./layoutWorkspaces.ts";

const layer = HoustonLayoutWorkspaces.layer.pipe(
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(NodeCrypto.layer),
);

const chat = (threadId: string): HoustonLayoutTabContent => ({
  kind: "chat",
  target: { kind: "server", threadRef: { environmentId: "env", threadId } },
});
const surface = (threadId: string, surfaceId = "diff"): HoustonLayoutTabContent => ({
  kind: "surface",
  threadRef: { environmentId: "env", threadId },
  surfaceId,
});

let counter = 0;
const unique = (prefix: string) => `${prefix}-${(counter += 1)}`;

const column = (...tabsPerPane: HoustonLayoutTabContent[][]): HoustonLayoutColumn => ({
  id: unique("column"),
  width: 1,
  panes: tabsPerPane.map((contents) => {
    const tabs = contents.map((content) => ({ id: unique("tab"), content }));
    return {
      id: unique("pane"),
      size: 1 / tabsPerPane.length,
      activeTabId: tabs[0]!.id,
      tabs,
    };
  }),
});

const record = (
  id: string,
  columns: HoustonLayoutColumn[] = [],
  overrides: Partial<HoustonLayoutWorkspaceRecord> = {},
): HoustonLayoutWorkspaceRecord => ({
  id,
  name: `Workspace ${id}`,
  position: 0,
  columns,
  pinnedAt: null,
  hidden: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  revision: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const failure = <A>(effect: Effect.Effect<A, HoustonLayoutWorkspaceError>) => Effect.flip(effect);

const create = (workspace: HoustonLayoutWorkspaceRecord) =>
  Effect.gen(function* () {
    const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
    const result = yield* service.put({ workspace, expectedRevision: 0 });
    assert.equal(result.status, "saved");
    return result.status === "saved" ? result.workspace : workspace;
  });

const tabContentsOf = (workspace: HoustonLayoutWorkspaceRecord) =>
  workspace.columns.flatMap((col) =>
    col.panes.flatMap((pane) => pane.tabs.map((tab) => tab.content)),
  );

describe("a fresh database", () => {
  it.effect("lists the one default workspace the migration guarantees", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const all = yield* service.list;
      assert.lengthOf(all, 1);
      assert.equal(all[0]!.name, "Workspace 1");
      assert.deepEqual((yield* service.get(all[0]!.id)).id, all[0]!.id);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("get of an unknown id is refused naming the id", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const error = yield* failure(service.get("nope"));
      assert.equal(error.kind, "not_found");
      assert.include(error.message, "nope");
    }).pipe(Effect.provide(layer)),
  );
});

describe("put and revisions", () => {
  it.effect("creating sets the revision, times and an appended position", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const saved = yield* create(
        record("a", [], { revision: 99, position: 42, createdAt: "1999-01-01T00:00:00.000Z" }),
      );
      assert.equal(saved.revision, 1);
      assert.equal(saved.position, 1);
      assert.notEqual(saved.createdAt, "1999-01-01T00:00:00.000Z");
      const second = yield* create(record("b"));
      assert.equal(second.position, 2);
      assert.deepEqual((yield* service.list).map((workspace) => workspace.id).slice(1), ["a", "b"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("an update with the stored revision saves and bumps it; the position stays", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const saved = yield* create(record("a"));
      const result = yield* service.put({
        workspace: { ...saved, name: "Renamed", position: 77, hidden: true },
        expectedRevision: 1,
      });
      assert.equal(result.status, "saved");
      if (result.status !== "saved") return;
      assert.deepInclude(result.workspace, {
        name: "Renamed",
        hidden: true,
        revision: 2,
        position: saved.position,
      });
      assert.equal(result.workspace.createdAt, saved.createdAt);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("saving unchanged content neither bumps the revision nor publishes", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const saved = yield* create(record("a"));
      const result = yield* service.put({ workspace: saved, expectedRevision: 1 });
      assert.deepEqual(result, { status: "saved", workspace: saved });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a stale revision returns the stored workspace and writes nothing", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const saved = yield* create(record("a"));
      yield* service.put({ workspace: { ...saved, name: "Newer" }, expectedRevision: 1 });
      const stale = yield* service.put({
        workspace: { ...saved, name: "Stale" },
        expectedRevision: 1,
      });
      assert.equal(stale.status, "conflict");
      if (stale.status === "conflict") assert.equal(stale.current?.name, "Newer");
      assert.equal((yield* service.get("a")).name, "Newer");
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "creating over an existing id conflicts, and updating a missing one conflicts with null",
    () =>
      Effect.gen(function* () {
        const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
        yield* create(record("a"));
        const again = yield* service.put({ workspace: record("a"), expectedRevision: 0 });
        assert.equal(again.status, "conflict");
        const missing = yield* service.put({ workspace: record("ghost"), expectedRevision: 3 });
        assert.deepEqual(missing, { status: "conflict", current: null });
      }).pipe(Effect.provide(layer)),
  );
});

describe("one tab per content", () => {
  it.effect("a second workspace cannot hold content another already shows", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      yield* create(record("a", [column([chat("t1")])]));
      const error = yield* failure(
        service.put({ workspace: record("b", [column([chat("t1")])]), expectedRevision: 0 }),
      );
      assert.equal(error.kind, "duplicate_content");
      assert.include(error.message, "chat:env:t1");
      assert.include(error.message, "'a'");
      assert.equal(error.operation, "houston.layoutWorkspaces.put");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("the same applies when an update adds content another workspace shows", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      yield* create(record("a", [column([chat("t1")])]));
      const b = yield* create(record("b"));
      const error = yield* failure(
        service.put({ workspace: { ...b, columns: [column([chat("t1")])] }, expectedRevision: 1 }),
      );
      assert.equal(error.kind, "duplicate_content");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("two tabs of one workspace cannot show the same content", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const error = yield* failure(
        service.put({
          workspace: record("a", [column([chat("t1")], [chat("t1")])]),
          expectedRevision: 0,
        }),
      );
      assert.equal(error.kind, "duplicate_content");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a chat tab and a surface tab of the same thread are different content", () =>
    create(record("a", [column([chat("t1"), surface("t1")])])).pipe(Effect.provide(layer)),
  );

  it.effect("moving a tab between workspaces works once the first drops it", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const a = yield* create(record("a", [column([chat("t1")])]));
      const b = yield* create(record("b"));
      yield* service.put({ workspace: { ...a, columns: [] }, expectedRevision: 1 });
      const moved = yield* service.put({
        workspace: { ...b, columns: a.columns },
        expectedRevision: 1,
      });
      assert.equal(moved.status, "saved");
    }).pipe(Effect.provide(layer)),
  );
});

describe("delete", () => {
  it.effect("refuses to delete the last workspace", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const [only] = yield* service.list;
      const error = yield* failure(service.delete({ workspaceId: only!.id }));
      assert.equal(error.kind, "last_workspace");
      assert.include(error.message, only!.id);
      assert.lengthOf(yield* service.list, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("deleting an unknown workspace reports deleted: false", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      assert.deepEqual(yield* service.delete({ workspaceId: "ghost" }), { deleted: false });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("moves the chat tabs of a deleted workspace to the first remaining workspace", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const [first] = yield* service.list;
      yield* create(
        record("a", [column([chat("t1")], [chat("t2"), surface("t2")]), column([chat("t3")])]),
      );
      assert.deepEqual(yield* service.delete({ workspaceId: "a" }), { deleted: true });
      const after = yield* service.get(first!.id);
      assert.deepEqual(
        tabContentsOf(after).map((content) => (content.kind === "chat" ? content.target : content)),
        [
          { kind: "server", threadRef: { environmentId: "env", threadId: "t1" } },
          { kind: "server", threadRef: { environmentId: "env", threadId: "t2" } },
          { kind: "server", threadRef: { environmentId: "env", threadId: "t3" } },
        ],
      );
      assert.equal(after.revision, first!.revision + 1);
      assert.lengthOf(yield* service.list, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "appends to the last pane when the target already has tabs and keeps its active tab",
    () =>
      Effect.gen(function* () {
        const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
        const [first] = yield* service.list;
        const target = column([chat("keep")]);
        yield* service.put({
          workspace: { ...first!, columns: [target] },
          expectedRevision: first!.revision,
        });
        yield* create(record("a", [column([chat("moved")])]));
        yield* service.delete({ workspaceId: "a" });
        const after = yield* service.get(first!.id);
        assert.lengthOf(after.columns, 1);
        assert.lengthOf(after.columns[0]!.panes, 1);
        assert.lengthOf(after.columns[0]!.panes[0]!.tabs, 2);
        assert.equal(after.columns[0]!.panes[0]!.activeTabId, target.panes[0]!.activeTabId);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("a deleted workspace with no chat tabs leaves the target unchanged", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const [first] = yield* service.list;
      yield* create(record("a", [column([surface("t9")])]));
      yield* service.delete({ workspaceId: "a" });
      assert.deepEqual(yield* service.get(first!.id), first);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("moves into the first workspace by position, not by creation", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const [original] = yield* service.list;
      yield* create(record("a"));
      yield* create(record("b", [column([chat("t1")])]));
      yield* service.reorder({ workspaceIds: ["a", original!.id, "b"] });
      yield* service.delete({ workspaceId: "b" });
      assert.deepEqual(tabContentsOf(yield* service.get("a")), [chat("t1")]);
      assert.deepEqual(tabContentsOf(yield* service.get(original!.id)), []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses when the moved tabs would break a bound, naming it, and deletes nothing", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const [first] = yield* service.list;
      const crowded: HoustonLayoutColumn = {
        id: unique("column"),
        width: 1,
        panes: [
          {
            id: unique("pane"),
            size: 1,
            activeTabId: null,
            tabs: Array.from({ length: LIMITS.tabsPerPane }, (_, i) => ({
              id: unique("tab"),
              content: chat(`full-${i}`),
            })),
          },
        ],
      };
      yield* service.put({
        workspace: { ...first!, columns: [crowded] },
        expectedRevision: first!.revision,
      });
      yield* create(record("a", [column([chat("extra")])]));
      const error = yield* failure(service.delete({ workspaceId: "a" }));
      assert.equal(error.kind, "limit");
      assert.equal(error.limit, LIMITS.tabsPerPane);
      assert.equal(error.actual, LIMITS.tabsPerPane + 1);
      assert.equal(error.operation, "houston.layoutWorkspaces.delete");
      assert.equal((yield* service.get("a")).id, "a");
    }).pipe(Effect.provide(layer)),
  );
});

describe("reorder", () => {
  it.effect("renumbers positions in the given order", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const [original] = yield* service.list;
      yield* create(record("a"));
      yield* create(record("b"));
      const ordered = yield* service.reorder({ workspaceIds: ["b", original!.id, "a"] });
      assert.deepEqual(
        ordered.map((workspace) => workspace.id),
        ["b", original!.id, "a"],
      );
      assert.deepEqual(
        ordered.map((workspace) => workspace.position),
        [0, 1, 2],
      );
      assert.deepEqual(
        (yield* service.list).map((workspace) => workspace.id),
        ["b", original!.id, "a"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("bumps only the revisions of workspaces whose position changed", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const [original] = yield* service.list;
      yield* create(record("a"));
      const ordered = yield* service.reorder({ workspaceIds: [original!.id, "a"] });
      assert.deepEqual(
        ordered.map((workspace) => workspace.revision),
        [original!.revision, 1],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a missing id is refused naming it and the expected count", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const [original] = yield* service.list;
      yield* create(record("a"));
      const error = yield* failure(service.reorder({ workspaceIds: [original!.id] }));
      assert.equal(error.kind, "invalid");
      assert.include(error.message, "'a'");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("an unknown or repeated id is refused naming it", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const [original] = yield* service.list;
      const unknown = yield* failure(service.reorder({ workspaceIds: [original!.id, "ghost"] }));
      assert.include(unknown.message, "ghost");
      const repeated = yield* failure(
        service.reorder({ workspaceIds: [original!.id, original!.id] }),
      );
      assert.include(repeated.message, original!.id);
    }).pipe(Effect.provide(layer)),
  );
});

describe("limits name the bound and the value", () => {
  const refused = (workspace: HoustonLayoutWorkspaceRecord) =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      return yield* failure(service.put({ workspace, expectedRevision: 0 }));
    });

  it.effect("a name over the limit", () =>
    Effect.gen(function* () {
      const error = yield* refused(record("a", [], { name: "x".repeat(LIMITS.nameChars + 1) }));
      assert.equal(error.kind, "limit");
      assert.equal(error.limit, LIMITS.nameChars);
      assert.equal(error.actual, LIMITS.nameChars + 1);
      assert.include(error.message, String(LIMITS.nameChars));
      assert.include(error.message, String(LIMITS.nameChars + 1));
      assert.equal(error.operation, "houston.layoutWorkspaces.put");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a blank name", () =>
    Effect.gen(function* () {
      const error = yield* refused(record("a", [], { name: "   " }));
      assert.equal(error.kind, "invalid");
      assert.include(error.message, "'a'");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("too many columns", () =>
    Effect.gen(function* () {
      const columns = Array.from({ length: LIMITS.columns + 1 }, (_, i) => column([chat(`c${i}`)]));
      const error = yield* refused(record("a", columns));
      assert.deepInclude(error, {
        kind: "limit",
        limit: LIMITS.columns,
        actual: LIMITS.columns + 1,
      });
      assert.include(error.message, String(LIMITS.columns + 1));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("too many panes in a column", () =>
    Effect.gen(function* () {
      const panes = Array.from({ length: LIMITS.panesPerColumn + 1 }, (_, i) => [chat(`p${i}`)]);
      const error = yield* refused(record("a", [column(...panes)]));
      assert.deepInclude(error, {
        kind: "limit",
        limit: LIMITS.panesPerColumn,
        actual: LIMITS.panesPerColumn + 1,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("too many tabs in a pane", () =>
    Effect.gen(function* () {
      const tabs = Array.from({ length: LIMITS.tabsPerPane + 1 }, (_, i) => chat(`t${i}`));
      const error = yield* refused(record("a", [column(tabs)]));
      assert.deepInclude(error, {
        kind: "limit",
        limit: LIMITS.tabsPerPane,
        actual: LIMITS.tabsPerPane + 1,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("too many tabs in a workspace", () =>
    Effect.gen(function* () {
      const perPane = 40;
      const panes = Array.from({ length: LIMITS.tabsPerWorkspace / perPane + 1 }, (_, p) =>
        Array.from({ length: perPane }, (_, t) => chat(`w${p}-${t}`)),
      );
      const error = yield* refused(record("a", [column(...panes)]));
      assert.deepInclude(error, {
        kind: "limit",
        limit: LIMITS.tabsPerWorkspace,
        actual: perPane * panes.length,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("an id over the limit", () =>
    Effect.gen(function* () {
      const error = yield* refused(record("x".repeat(LIMITS.idChars + 1), [], { name: "Long id" }));
      assert.deepInclude(error, {
        kind: "limit",
        limit: LIMITS.idChars,
        actual: LIMITS.idChars + 1,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("an active tab that is not in its pane", () =>
    Effect.gen(function* () {
      const bad = column([chat("t1")]);
      const error = yield* refused(
        record("a", [{ ...bad, panes: [{ ...bad.panes[0]!, activeTabId: "elsewhere" }] }]),
      );
      assert.equal(error.kind, "invalid");
      assert.include(error.message, "elsewhere");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("the workspace cap names the cap, the count and the request", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const existing = (yield* service.list).length;
      for (let i = existing; i < LIMITS.workspaces; i += 1) yield* create(record(`fill-${i}`));
      const error = yield* refused(record("one-too-many"));
      assert.deepInclude(error, {
        kind: "limit",
        limit: LIMITS.workspaces,
        actual: LIMITS.workspaces,
      });
      assert.include(error.message, String(LIMITS.workspaces));
      assert.include(error.message, "1 more");
    }).pipe(Effect.provide(layer)),
  );
});

describe("the stream", () => {
  it.effect("opens with a snapshot, then carries a put, a reorder and a delete", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const [original] = yield* service.list;
      const watcher = yield* service.subscribe.pipe(
        Stream.take(8),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* create(record("a", [column([chat("t1")])]));
      yield* service.reorder({ workspaceIds: ["a", original!.id] });
      yield* service.delete({ workspaceId: "a" });
      const events = yield* Fiber.join(watcher);
      const shapes = events.map((event) => Object.keys(event)[0]);
      assert.deepEqual(shapes.slice(0, 2), ["snapshot", "upserted"]);
      assert.include(shapes, "deleted");
      const snapshot = events[0] as { snapshot: { workspaces: ReadonlyArray<{ id: string }> } };
      assert.deepEqual(
        snapshot.snapshot.workspaces.map((workspace) => workspace.id),
        [original!.id],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a refused change publishes nothing", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      const [original] = yield* service.list;
      const watcher = yield* service.subscribe.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* failure(service.delete({ workspaceId: original!.id }));
      yield* create(record("a"));
      const events = yield* Fiber.join(watcher);
      assert.deepEqual(
        events.map((event) => Object.keys(event)[0]),
        ["snapshot", "upserted"],
      );
    }).pipe(Effect.provide(layer)),
  );
});

describe("a stored layout from before Usage left the page kinds", () => {
  const storeRaw = (id: string, columns: unknown[]) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const stored = {
        ...record(id),
        columns,
        position: 5,
        revision: 1,
      };
      yield* sql`
        INSERT INTO houston_layout_workspaces (id, position, record_json, revision, created_at, updated_at)
        VALUES (${id}, 5, ${JSON.stringify(stored)}, 1, ${stored.createdAt}, ${stored.updatedAt})
      `;
    });
  const rawTab = (id: string, content: unknown) => ({ id, content });
  const usageContent = { kind: "page", page: "usage" };
  const rawPane = (id: string, size: number, activeTabId: string | null, tabs: unknown[]) => ({
    id,
    size,
    activeTabId,
    tabs,
  });

  it.effect("loads with the usage tab dropped and the pane's active tab moved on", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      yield* storeRaw("legacy", [
        {
          id: "c1",
          width: 1,
          panes: [
            rawPane("p1", 1, "t-usage", [
              rawTab("t-usage", usageContent),
              rawTab("t-chat", chat("thread-1")),
            ]),
          ],
        },
      ]);
      const loaded = yield* service.get("legacy");
      const pane = loaded.columns[0]!.panes[0]!;
      assert.deepEqual(
        pane.tabs.map((tab) => tab.id),
        ["t-chat"],
      );
      assert.equal(pane.activeTabId, "t-chat");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("drops a pane whose only tab was usage and rescales its siblings", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      yield* storeRaw("legacy", [
        {
          id: "c1",
          width: 1,
          panes: [
            rawPane("p1", 0.5, "t-chat", [rawTab("t-chat", chat("thread-1"))]),
            rawPane("p2", 0.5, "t-usage", [rawTab("t-usage", usageContent)]),
          ],
        },
        {
          id: "c2",
          width: 0.5,
          panes: [
            rawPane("p3", 1, "t-usage-2", [rawTab("t-usage-2", { kind: "page", page: "usage" })]),
          ],
        },
      ]);
      const loaded = yield* service.get("legacy");
      assert.deepEqual(
        loaded.columns.map((col) => col.id),
        ["c1"],
      );
      assert.deepEqual(
        loaded.columns[0]!.panes.map((pane) => [pane.id, pane.size]),
        [["p1", 1]],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a workspace that held only usage loads empty and still lists", () =>
    Effect.gen(function* () {
      const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
      yield* storeRaw("legacy", [
        {
          id: "c1",
          width: 1,
          panes: [rawPane("p1", 1, "t-usage", [rawTab("t-usage", usageContent)])],
        },
      ]);
      const loaded = yield* service.get("legacy");
      assert.deepEqual(loaded.columns, []);
      assert.include(
        (yield* service.list).map((workspace) => workspace.id),
        "legacy",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a tasks page tab is stored and loaded", () =>
    Effect.gen(function* () {
      const saved = yield* create(record("t", [column([{ kind: "page", page: "tasks" }])]));
      assert.deepEqual(tabContentsOf(saved), [{ kind: "page", page: "tasks" }]);
    }).pipe(Effect.provide(layer)),
  );
});
