// Thread membership: which workspace each chat thread belongs to, how it is assigned when a thread
// is created, how it moves with its tabs, and how a workspace's deletion treats its threads.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@houston-app/contracts";
import {
  type HoustonLayoutColumn,
  type HoustonLayoutTabContent,
  type HoustonLayoutWorkspaceError,
  type HoustonLayoutWorkspaceRecord,
} from "@houston-app/contracts/houston/layoutWorkspaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as HoustonLayoutWorkspaces from "./layoutWorkspaces.ts";
import { membershipsFromTabs } from "./membershipBackfill.ts";
import * as HoustonThreadMembership from "./threadMembership.ts";

const ENV = "env";

const layer = HoustonThreadMembership.layer.pipe(
  Layer.provideMerge(HoustonLayoutWorkspaces.layer),
  Layer.provideMerge(
    Layer.succeed(Orchestrator.OrchestratorV2, {
      streamDomainEvents: Stream.empty,
    } as unknown as Orchestrator.OrchestratorV2["Service"]),
  ),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(ENV),
    } as unknown as ServerEnvironment.ServerEnvironment["Service"]),
  ),
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(NodeCrypto.layer),
);

const chat = (threadId: string): HoustonLayoutTabContent => ({
  kind: "chat",
  target: { kind: "server", threadRef: { environmentId: ENV, threadId } },
});

let counter = 0;
const unique = (prefix: string) => `${prefix}-${(counter += 1)}`;

const column = (...tabsPerPane: HoustonLayoutTabContent[][]): HoustonLayoutColumn => ({
  id: unique("column"),
  width: 1,
  panes: tabsPerPane.map((contents) => {
    const tabs = contents.map((content) => ({ id: unique("tab"), content }));
    return { id: unique("pane"), size: 1 / tabsPerPane.length, activeTabId: tabs[0]!.id, tabs };
  }),
});

const record = (id: string, columns: HoustonLayoutColumn[] = []): HoustonLayoutWorkspaceRecord => ({
  id,
  name: `Workspace ${id}`,
  position: 0,
  columns,
  pinnedAt: null,
  hidden: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  revision: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const failure = <A>(effect: Effect.Effect<A, HoustonLayoutWorkspaceError>) => Effect.flip(effect);

const svc = HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;

const create = (workspace: HoustonLayoutWorkspaceRecord) =>
  Effect.gen(function* () {
    const service = yield* svc;
    const result = yield* service.put({ workspace, expectedRevision: 0 });
    assert.equal(result.status, "saved");
    return result.status === "saved" ? result.workspace : workspace;
  });

/** The workspace of each thread, by id. */
const placement = Effect.gen(function* () {
  const service = yield* svc;
  return Object.fromEntries(
    (yield* service.memberships).map((row) => [row.threadId, row.workspaceId]),
  );
});

const chatIdsIn = (workspace: HoustonLayoutWorkspaceRecord) =>
  workspace.columns.flatMap((c) =>
    c.panes.flatMap((p) =>
      p.tabs.flatMap((t) =>
        t.content.kind === "chat" && t.content.target.kind === "server"
          ? [t.content.target.threadRef.threadId]
          : [],
      ),
    ),
  );

/** A thread.created event as the orchestrator emits it, reduced to what membership reads. */
const created = (
  threadId: string,
  lineage: {
    parentThreadId?: string | null;
    relationshipToParent?: "fork" | "subagent" | null;
    sideChat?: boolean;
  } = {},
  extra: Record<string, unknown> = {},
) =>
  ({
    type: "thread.created",
    threadId,
    payload: {
      id: threadId,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
        ...lineage,
      },
      forkedFrom: null,
      ...extra,
    },
  }) as unknown as OrchestrationV2DomainEvent;

const deleted = (threadId: string) =>
  ({ type: "thread.deleted", threadId }) as unknown as OrchestrationV2DomainEvent;

const insertThread = (id: string, deletedAt: string | null = null, payload: object = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title,
        default_provider, provider_instance_id, runtime_mode, interaction_mode, created_at,
        updated_at, archived_at, deleted_at, payload_json)
      VALUES (${id}, 'project', ${id}, 'codex', 'codex', 'full-access', 'default', '2026-01-01',
        '2026-01-01', NULL, ${deletedAt}, ${JSON.stringify(payload)})
    `;
  });

describe("a thread created by an agent or outside the window", () => {
  it.effect("rule 4: a thread another agent delegated lands in its parent's workspace", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      const reactor = yield* HoustonThreadMembership.HoustonThreadMembership;
      const [first] = yield* service.list;
      yield* create(record("other"));
      yield* service.assignThread({ environmentId: ENV, threadId: "parent", workspaceId: "other" });
      yield* service.setFocus(first!.id);
      yield* reactor.handle(
        created("child", { parentThreadId: "parent", relationshipToParent: "subagent" }),
      );
      assert.deepEqual(yield* placement, { parent: "other", child: "other" });
      const child = (yield* service.memberships).find((row) => row.threadId === "child");
      assert.equal(child?.parentThreadId, "parent");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rule 5: a thread with no parent goes to the workspace last reported as focused", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      const reactor = yield* HoustonThreadMembership.HoustonThreadMembership;
      yield* create(record("second"));
      yield* service.setFocus("second");
      yield* reactor.handle(created("scheduled"));
      assert.deepEqual(yield* placement, { scheduled: "second" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rule 5: with no focus reported it goes to the first workspace", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      const reactor = yield* HoustonThreadMembership.HoustonThreadMembership;
      const [first] = yield* service.list;
      yield* create(record("second"));
      yield* reactor.handle(created("scheduled"));
      assert.deepEqual(yield* placement, { scheduled: first!.id });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rule 5: a focus that points at a deleted workspace falls back to the first", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      const reactor = yield* HoustonThreadMembership.HoustonThreadMembership;
      const [first] = yield* service.list;
      yield* create(record("gone"));
      yield* service.setFocus("gone");
      yield* service.delete({ workspaceId: "gone" });
      yield* reactor.handle(created("slack"));
      assert.deepEqual(yield* placement, { slack: first!.id });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rule 5: a focus report for a missing workspace is refused naming it", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      const error = yield* failure(service.setFocus("nowhere"));
      assert.equal(error.kind, "not_found");
      assert.include(error.message, "nowhere");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rule 6: a fork lands in its source thread's workspace and does not follow it", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      const reactor = yield* HoustonThreadMembership.HoustonThreadMembership;
      const [first] = yield* service.list;
      yield* create(record("other"));
      yield* service.setFocus(first!.id);
      yield* service.assignThread({ environmentId: ENV, threadId: "source", workspaceId: "other" });
      yield* reactor.handle(
        created("fork", { parentThreadId: "source", relationshipToParent: "fork" }),
      );
      assert.deepEqual(yield* placement, { source: "other", fork: "other" });
      const fork = (yield* service.memberships).find((row) => row.threadId === "fork");
      assert.equal(fork?.parentThreadId, null);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rule 7: a side thread has no membership of its own", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      const reactor = yield* HoustonThreadMembership.HoustonThreadMembership;
      const [first] = yield* service.list;
      yield* service.assignThread({
        environmentId: ENV,
        threadId: "source",
        workspaceId: first!.id,
      });
      yield* reactor.handle(
        created("chat-aside", {
          parentThreadId: "source",
          relationshipToParent: "fork",
          sideChat: true,
        }),
      );
      yield* reactor.handle(
        created(
          "reviewer",
          { parentThreadId: "source", relationshipToParent: "fork" },
          {
            side: { kind: "second-opinion" },
          },
        ),
      );
      assert.deepEqual(yield* placement, { source: first!.id });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a thread the window already placed keeps that workspace when it is created", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      const reactor = yield* HoustonThreadMembership.HoustonThreadMembership;
      const [first] = yield* service.list;
      yield* create(record("chosen"));
      yield* service.setFocus(first!.id);
      yield* service.assignThread({ environmentId: ENV, threadId: "ui", workspaceId: "chosen" });
      yield* reactor.handle(created("ui"));
      assert.deepEqual(yield* placement, { ui: "chosen" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rule 3: a draft that never becomes a thread writes nothing", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      assert.deepEqual(yield* service.memberships, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("assigning to a missing workspace is refused naming the workspace id", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      const error = yield* failure(
        service.assignThread({ environmentId: ENV, threadId: "t", workspaceId: "missing" }),
      );
      assert.equal(error.kind, "not_found");
      assert.include(error.message, "missing");
      assert.deepEqual(yield* service.memberships, []);
    }).pipe(Effect.provide(layer)),
  );
});

describe("upgrade of an existing database", () => {
  it("rule 8: a thread with a tab takes that tab's workspace; with several, the focused one if it holds one, else the first", () => {
    const tabsIn = (id: string, ...threads: string[]) => ({
      id,
      columns: [{ panes: [{ tabs: threads.map((threadId) => ({ content: chat(threadId) })) }] }],
    });
    const workspaces = [tabsIn("a", "one", "both"), tabsIn("b", "two", "both")];
    const pick = (focused?: string) =>
      Object.fromEntries(
        membershipsFromTabs(workspaces, focused).map((m) => [m.threadId, m.workspaceId]),
      );
    assert.deepEqual(pick(), { one: "a", both: "a", two: "b" });
    assert.deepEqual(pick("b"), { one: "a", both: "b", two: "b" });
    assert.deepEqual(pick("c"), { one: "a", both: "a", two: "b" });
  });

  it.effect(
    "rule 8: a thread with no tab gets the first workspace; entries of vanished threads go",
    () =>
      Effect.gen(function* () {
        const service = yield* svc;
        const [first] = yield* service.list;
        yield* create(record("other"));
        yield* insertThread("untabbed");
        yield* insertThread("kept");
        yield* insertThread("kid", null, {
          lineage: { parentThreadId: "kept", relationshipToParent: "subagent" },
        });
        yield* insertThread("aside", null, { lineage: { sideChat: true } });
        yield* insertThread("trashed", "2026-01-02");
        yield* service.assignThread({ environmentId: ENV, threadId: "kept", workspaceId: "other" });
        yield* service.assignThread({
          environmentId: ENV,
          threadId: "vanished",
          workspaceId: "other",
        });
        const result = yield* service.reconcileThreads(ENV);
        assert.deepEqual(result, { assigned: 2, removed: 1 });
        assert.deepEqual(yield* placement, {
          kept: "other",
          kid: "other",
          untabbed: first!.id,
        });
      }).pipe(Effect.provide(layer)),
  );
});

describe("movement", () => {
  it.effect("rule 9: closing a thread's last tab keeps its membership", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      const [first] = yield* service.list;
      const withTab = yield* create(record("w", [column([chat("t")])]));
      assert.deepEqual(yield* placement, { t: "w" });
      yield* service.put({ workspace: { ...withTab, columns: [] }, expectedRevision: 1 });
      assert.deepEqual(yield* placement, { t: "w" });
      assert.notEqual(first!.id, "w");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rule 11: a chat tab saved into another workspace moves the membership with it", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      const a = yield* create(record("a", [column([chat("t")])]));
      const b = yield* create(record("b"));
      yield* service.put({ workspace: { ...a, columns: [] }, expectedRevision: a.revision });
      yield* service.put({
        workspace: { ...b, columns: [column([chat("t")])] },
        expectedRevision: b.revision,
      });
      assert.deepEqual(yield* placement, { t: "b" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rule 11: moving a thread takes its tabs out of the other workspace in one step", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      yield* create(record("a", [column([chat("t"), chat("keep")])]));
      yield* create(record("b", [column([chat("u")])]));
      const result = yield* service.moveThread({
        environmentId: ENV,
        threadId: "t",
        workspaceId: "b",
      });
      assert.equal(result.membership.workspaceId, "b");
      assert.equal(result.previous.workspaceId, "a");
      assert.equal(result.previous.index, 0);
      const a = yield* service.get("a");
      const b = yield* service.get("b");
      assert.deepEqual(chatIdsIn(a), ["keep"]);
      assert.deepEqual(chatIdsIn(b), ["u", "t"]);
      assert.deepEqual(yield* placement, { keep: "a", t: "b", u: "b" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rule 12: tabs land in the pane the caller names, at the index it names", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      yield* create(record("a", [column([chat("t")])]));
      const b = yield* create(record("b", [column([chat("u"), chat("v")], [chat("w")])]));
      const pane = b.columns[0]!.panes[0]!;
      yield* service.moveThread({
        environmentId: ENV,
        threadId: "t",
        workspaceId: "b",
        paneId: pane.id,
        index: 1,
      });
      assert.deepEqual(chatIdsIn(yield* service.get("b")), ["u", "t", "v", "w"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rule 12: moving back to the reported previous position restores the placement", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      yield* create(record("a", [column([chat("x"), chat("t"), chat("y")])]));
      yield* create(record("b"));
      const moved = yield* service.moveThread({
        environmentId: ENV,
        threadId: "t",
        workspaceId: "b",
      });
      const back = moved.previous;
      yield* service.moveThread({
        environmentId: ENV,
        threadId: "t",
        workspaceId: back.workspaceId!,
        ...(back.paneId === null ? {} : { paneId: back.paneId }),
        ...(back.index === null ? {} : { index: back.index }),
      });
      assert.deepEqual(chatIdsIn(yield* service.get("a")), ["x", "t", "y"]);
      assert.deepEqual(chatIdsIn(yield* service.get("b")), []);
      assert.equal((yield* placement).t, "a");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rule 12: a thread with no open tab moves its membership alone", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      const [first] = yield* service.list;
      yield* create(record("b"));
      yield* service.assignThread({ environmentId: ENV, threadId: "t", workspaceId: first!.id });
      const moved = yield* service.moveThread({
        environmentId: ENV,
        threadId: "t",
        workspaceId: "b",
      });
      assert.equal(moved.previous.workspaceId, first!.id);
      assert.equal(moved.previous.paneId, null);
      assert.deepEqual(yield* placement, { t: "b" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rule 13: moving a parent moves its children, and a child cannot move alone", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      const reactor = yield* HoustonThreadMembership.HoustonThreadMembership;
      const [first] = yield* service.list;
      yield* create(record("b"));
      yield* service.assignThread({ environmentId: ENV, threadId: "p", workspaceId: first!.id });
      yield* reactor.handle(
        created("c", { parentThreadId: "p", relationshipToParent: "subagent" }),
      );
      const error = yield* failure(
        service.moveThread({ environmentId: ENV, threadId: "c", workspaceId: "b" }),
      );
      assert.equal(error.kind, "invalid");
      assert.include(error.message, "'p'");
      yield* service.moveThread({ environmentId: ENV, threadId: "p", workspaceId: "b" });
      assert.deepEqual(yield* placement, { p: "b", c: "b" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rule 14: pages and launchers keep no membership and may live in any workspace", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      yield* create(
        record("a", [
          column([
            { kind: "page", page: "tasks" },
            { kind: "launcher", id: "l1", context: null },
          ]),
        ]),
      );
      assert.deepEqual(yield* service.memberships, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rule 16: renaming and reordering workspaces leave every membership alone", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      const [first] = yield* service.list;
      const a = yield* create(record("a", [column([chat("t")])]));
      yield* service.put({ workspace: { ...a, name: "Renamed" }, expectedRevision: a.revision });
      yield* service.reorder({ workspaceIds: ["a", first!.id] });
      assert.deepEqual(yield* placement, { t: "a" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rule 17: archiving changes nothing and a deleted thread loses its entry", () =>
    Effect.gen(function* () {
      const reactor = yield* HoustonThreadMembership.HoustonThreadMembership;
      yield* create(record("a", [column([chat("t")])]));
      yield* reactor.handle({ type: "thread.archived", threadId: "t" } as never);
      assert.deepEqual(yield* placement, { t: "a" });
      yield* reactor.handle(deleted("t"));
      assert.deepEqual(yield* placement, {});
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "rule 18: an entry that names a missing workspace is repaired to the first on load",
    () =>
      Effect.gen(function* () {
        const service = yield* svc;
        const sql = yield* SqlClient.SqlClient;
        const [first] = yield* service.list;
        yield* sql`
        INSERT INTO houston_layout_thread_membership (environment_id, thread_id, workspace_id)
        VALUES (${ENV}, 'orphan', 'deleted-long-ago')
      `;
        const events = yield* service.subscribe.pipe(Stream.take(1), Stream.runCollect);
        const snapshot = events[0] as {
          snapshot: { memberships: ReadonlyArray<{ threadId: string; workspaceId: string }> };
        };
        assert.deepEqual(
          snapshot.snapshot.memberships.map((m) => [m.threadId, m.workspaceId]),
          [["orphan", first!.id]],
        );
        assert.deepEqual(yield* placement, { orphan: first!.id });
      }).pipe(Effect.provide(layer)),
  );
});

describe("concurrency", () => {
  it.effect("rule 19: the last of two moves wins and both callers see the same workspace", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      yield* create(record("a", [column([chat("t")])]));
      yield* create(record("b"));
      yield* create(record("c"));
      yield* service.moveThread({ environmentId: ENV, threadId: "t", workspaceId: "b" });
      yield* service.moveThread({ environmentId: ENV, threadId: "t", workspaceId: "c" });
      assert.deepEqual(yield* placement, { t: "c" });
      assert.deepEqual(chatIdsIn(yield* service.get("c")), ["t"]);
      assert.deepEqual(chatIdsIn(yield* service.get("b")), []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "rule 19: a move to a workspace that no longer exists is refused naming it and changes nothing",
    () =>
      Effect.gen(function* () {
        const service = yield* svc;
        yield* create(record("a", [column([chat("t")])]));
        yield* create(record("b"));
        yield* service.delete({ workspaceId: "b" });
        const error = yield* failure(
          service.moveThread({ environmentId: ENV, threadId: "t", workspaceId: "b" }),
        );
        assert.equal(error.kind, "not_found");
        assert.include(error.message, "'b'");
        assert.deepEqual(yield* placement, { t: "a" });
        assert.deepEqual(chatIdsIn(yield* service.get("a")), ["t"]);
      }).pipe(Effect.provide(layer)),
  );
});

describe("deleting a workspace", () => {
  it.effect(
    "rule 15: a workspace with a live thread is refused, naming the workspace and the count",
    () =>
      Effect.gen(function* () {
        const service = yield* svc;
        yield* create(record("doomed", [column([chat("t1"), chat("t2")])]));
        yield* insertThread("t1");
        yield* insertThread("t2");
        const error = yield* failure(service.delete({ workspaceId: "doomed" }));
        assert.equal(error.kind, "has_threads");
        assert.include(error.message, "'doomed'");
        assert.include(error.message, "2 threads");
        assert.deepEqual(error.actual, 2);
        assert.equal(
          (yield* service.list).some((w) => w.id === "doomed"),
          true,
        );
        assert.deepEqual(yield* placement, { t1: "doomed", t2: "doomed" });
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "rule 15: once its threads are deleted the workspace goes with their tabs and entries",
    () =>
      Effect.gen(function* () {
        const service = yield* svc;
        const [first] = yield* service.list;
        yield* create(record("doomed", [column([chat("t1"), { kind: "page", page: "tasks" }])]));
        yield* insertThread("t1", "2026-01-02");
        const result = yield* service.delete({ workspaceId: "doomed" });
        assert.deepEqual(result, { deleted: true });
        assert.deepEqual(yield* placement, {});
        const remaining = yield* service.get(first!.id);
        assert.deepEqual(chatIdsIn(remaining), []);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("rule 15: an empty workspace is deleted without any thread work", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      yield* create(record("empty"));
      assert.deepEqual(yield* service.delete({ workspaceId: "empty" }), { deleted: true });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rule 15: the last workspace cannot be deleted", () =>
    Effect.gen(function* () {
      const service = yield* svc;
      const [only] = yield* service.list;
      const error = yield* failure(service.delete({ workspaceId: only!.id }));
      assert.equal(error.kind, "last_workspace");
    }).pipe(Effect.provide(layer)),
  );
});
