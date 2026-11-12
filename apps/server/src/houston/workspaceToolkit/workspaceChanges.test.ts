// Placing a thread in a workspace: where its tab goes, moving it out of its other workspace, the
// bounds that refuse it, and the bounded retry on a revision conflict.
import { assert, it } from "@effect/vitest";
import { HOUSTON_LAYOUT_WORKSPACE_LIMITS as LIMITS } from "@houston-app/contracts/houston/layoutWorkspaces";
import * as Effect from "effect/Effect";

import * as HoustonLayoutWorkspaces from "../layoutWorkspaces.ts";
import { PLACEMENT_ATTEMPTS, placeThread, removeThread } from "./workspaceChanges.ts";
import {
  chatContent,
  chatThreadsOf,
  columnOf,
  layerWorkspaces,
  seedWorkspace,
  surfaceContent,
  WORKSPACE_TEST_ENVIRONMENT as environmentId,
  workspaceRecord,
} from "./workspaceToolkit.testkit.ts";

const Service = HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;

const get = (workspaceId: string) =>
  Effect.gen(function* () {
    return yield* (yield* Service).get(workspaceId);
  });

it.effect("puts a new tab at the end of the last pane of the last column", () =>
  Effect.gen(function* () {
    yield* seedWorkspace(
      workspaceRecord("w", [
        columnOf([chatContent("a")]),
        columnOf([chatContent("b")], [chatContent("c")]),
      ]),
    );
    const placed = yield* placeThread({ workspaceId: "w", threadId: "d", environmentId });
    assert.deepEqual(chatThreadsOf(placed), ["a", "b", "c", "d"]);
    assert.equal(placed.columns.length, 2);
    assert.equal(placed.columns[1]!.panes.length, 2);
    assert.equal(placed.columns[1]!.panes[1]!.tabs.length, 2);
    // The pane's focus stays where it was.
    assert.equal(
      placed.columns[1]!.panes[1]!.activeTabId,
      placed.columns[1]!.panes[1]!.tabs[0]!.id,
    );
    assert.equal(placed.revision, 2);
  }).pipe(Effect.provide(layerWorkspaces)),
);

it.effect("makes a column for the first tab of an empty workspace and focuses it", () =>
  Effect.gen(function* () {
    yield* seedWorkspace(workspaceRecord("w"));
    const placed = yield* placeThread({ workspaceId: "w", threadId: "a", environmentId });
    assert.equal(placed.columns.length, 1);
    const pane = placed.columns[0]!.panes[0]!;
    assert.equal(pane.tabs.length, 1);
    assert.equal(pane.activeTabId, pane.tabs[0]!.id);
    assert.equal(placed.columns[0]!.width, 1);
    assert.equal(pane.size, 1);
  }).pipe(Effect.provide(layerWorkspaces)),
);

it.effect("moves a thread out of its other workspace, keeping that workspace's other tabs", () =>
  Effect.gen(function* () {
    yield* seedWorkspace(
      workspaceRecord("from", [
        columnOf([chatContent("a"), surfaceContent("a"), chatContent("b")]),
      ]),
    );
    yield* seedWorkspace(workspaceRecord("to", [columnOf([chatContent("c")])], { position: 1 }));
    const placed = yield* placeThread({ workspaceId: "to", threadId: "a", environmentId });
    assert.deepEqual(chatThreadsOf(placed), ["c", "a"]);
    const from = yield* get("from");
    assert.deepEqual(chatThreadsOf(from), ["b"]);
    // The thread's surface tab outlives its chat tab.
    assert.equal(
      from.columns[0]!.panes[0]!.tabs.some((tab) => tab.content.kind === "surface"),
      true,
    );
  }).pipe(Effect.provide(layerWorkspaces)),
);

it.effect("drops the panes and columns a moved tab leaves empty and refocuses the pane", () =>
  Effect.gen(function* () {
    yield* seedWorkspace(
      workspaceRecord("from", [
        columnOf([chatContent("a")]),
        columnOf([chatContent("b"), chatContent("c")], [chatContent("d")]),
      ]),
    );
    yield* seedWorkspace(workspaceRecord("to", [], { position: 1 }));
    yield* placeThread({ workspaceId: "to", threadId: "a", environmentId });
    yield* placeThread({ workspaceId: "to", threadId: "d", environmentId });
    const from = yield* get("from");
    assert.equal(from.columns.length, 1);
    assert.equal(from.columns[0]!.panes.length, 1);
    assert.deepEqual(chatThreadsOf(from), ["b", "c"]);
    const pane = from.columns[0]!.panes[0]!;
    assert.closeTo(pane.size, 1, 1e-9);
    assert.equal(pane.activeTabId, pane.tabs[0]!.id);
  }).pipe(Effect.provide(layerWorkspaces)),
);

it.effect("leaves a thread already in the workspace where it is", () =>
  Effect.gen(function* () {
    const seeded = yield* seedWorkspace(
      workspaceRecord("w", [columnOf([chatContent("a"), chatContent("b")])]),
    );
    const placed = yield* placeThread({ workspaceId: "w", threadId: "a", environmentId });
    assert.deepEqual(chatThreadsOf(placed), ["a", "b"]);
    assert.equal(placed.revision, seeded.revision);
  }).pipe(Effect.provide(layerWorkspaces)),
);

it.effect("refuses a missing workspace naming it", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      placeThread({ workspaceId: "ghost", threadId: "a", environmentId }),
    );
    assert.include(error, { kind: "not_found" });
    assert.include(error.message, "ghost");
  }).pipe(Effect.provide(layerWorkspaces)),
);

it.effect("refuses a full pane's overflow with the limit and the value, and moves nothing", () =>
  Effect.gen(function* () {
    // One pane holds the maximum; the workspace-wide bound is not reached.
    const full = Array.from({ length: LIMITS.tabsPerPane }, (_, n) => chatContent(`full-${n}`));
    yield* seedWorkspace(workspaceRecord("to", [columnOf(full)]));
    yield* seedWorkspace(workspaceRecord("from", [columnOf([chatContent("a")])], { position: 1 }));
    const error = yield* Effect.flip(
      placeThread({ workspaceId: "to", threadId: "a", environmentId }),
    );
    assert.include(error, {
      kind: "limit",
      limit: LIMITS.tabsPerPane,
      actual: LIMITS.tabsPerPane + 1,
    });
    assert.include(error.message, String(LIMITS.tabsPerPane));
    assert.deepEqual(chatThreadsOf(yield* get("from")), ["a"]);
  }).pipe(Effect.provide(layerWorkspaces)),
);

it.effect("refuses past the workspace's tab bound with the limit and the value", () =>
  Effect.gen(function* () {
    // Eight panes of 25 tabs in two columns: no column or pane bound trips before the workspace's.
    const panes = Array.from({ length: 8 }, (_, p) =>
      Array.from({ length: LIMITS.tabsPerWorkspace / 8 }, (_, n) => chatContent(`t-${p}-${n}`)),
    );
    // Four columns of four panes: no column or pane bound trips before the workspace's.
    yield* seedWorkspace(
      workspaceRecord("to", [columnOf(...panes.slice(0, 2)), columnOf(...panes.slice(2))]),
    );
    const error = yield* Effect.flip(
      placeThread({ workspaceId: "to", threadId: "one-more", environmentId }),
    );
    assert.include(error, {
      kind: "limit",
      limit: LIMITS.tabsPerWorkspace,
      actual: LIMITS.tabsPerWorkspace + 1,
    });
  }).pipe(Effect.provide(layerWorkspaces)),
);

/** `real` with its first `conflicts` puts, counted from the first put after this call, reporting a conflict as a renderer save would. */
const conflicting = (
  real: HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService["Service"],
  conflicts: (putNumber: number) => boolean,
) => {
  const state = { puts: 0 };
  const service = Service.of({
    ...real,
    put: (input) => {
      state.puts += 1;
      if (!conflicts(state.puts)) return real.put(input);
      return real
        .get(input.workspace.id)
        .pipe(Effect.map((current) => ({ status: "conflict" as const, current })));
    },
  });
  return { state, service };
};

it.effect("retries a revision conflict and places the thread", () =>
  Effect.gen(function* () {
    yield* seedWorkspace(workspaceRecord("w", [columnOf([chatContent("a")])]));
    const { state, service } = conflicting(yield* Service, (put) => put <= 2);
    const placed = yield* placeThread({ workspaceId: "w", threadId: "b", environmentId }).pipe(
      Effect.provideService(Service, service),
    );
    assert.deepEqual(chatThreadsOf(placed), ["a", "b"]);
    assert.equal(state.puts, 3);
  }).pipe(Effect.provide(layerWorkspaces)),
);

it.effect("refuses after the retry bound naming it and the attempts made", () =>
  Effect.gen(function* () {
    yield* seedWorkspace(workspaceRecord("w", [columnOf([chatContent("a")])]));
    const { state, service } = conflicting(yield* Service, () => true);
    const error = yield* Effect.flip(
      placeThread({ workspaceId: "w", threadId: "b", environmentId }).pipe(
        Effect.provideService(Service, service),
      ),
    );
    assert.include(error, { kind: "limit", limit: PLACEMENT_ATTEMPTS, actual: PLACEMENT_ATTEMPTS });
    assert.include(error.message, "w");
    assert.equal(state.puts, PLACEMENT_ATTEMPTS);
  }).pipe(Effect.provide(layerWorkspaces)),
);

it.effect("a conflict after the old workspace was emptied still places the thread once", () =>
  Effect.gen(function* () {
    yield* seedWorkspace(workspaceRecord("from", [columnOf([chatContent("a")])]));
    yield* seedWorkspace(workspaceRecord("to", [columnOf([chatContent("c")])], { position: 1 }));
    // Put 1 takes the tab out of "from"; put 2, into "to", conflicts; put 3 retries into "to".
    const { service } = conflicting(yield* Service, (put) => put === 2);
    const placed = yield* placeThread({ workspaceId: "to", threadId: "a", environmentId }).pipe(
      Effect.provideService(Service, service),
    );
    assert.deepEqual(chatThreadsOf(placed), ["c", "a"]);
    assert.deepEqual(chatThreadsOf(yield* get("from")), []);
  }).pipe(Effect.provide(layerWorkspaces)),
);

it.effect("removes a thread's chat tab only, and refuses a thread that is not there", () =>
  Effect.gen(function* () {
    yield* seedWorkspace(
      workspaceRecord("w", [columnOf([chatContent("a"), surfaceContent("a"), chatContent("b")])]),
    );
    const removed = yield* removeThread({ workspaceId: "w", threadId: "a", environmentId });
    assert.deepEqual(chatThreadsOf(removed), ["b"]);
    assert.equal(removed.columns[0]!.panes[0]!.tabs.length, 2);
    const error = yield* Effect.flip(
      removeThread({ workspaceId: "w", threadId: "a", environmentId }),
    );
    assert.include(error, { kind: "not_found" });
    assert.include(error.message, "a");
    assert.include(error.message, "w");
  }).pipe(Effect.provide(layerWorkspaces)),
);

it.effect("removing the last tab leaves the workspace with no columns", () =>
  Effect.gen(function* () {
    yield* seedWorkspace(workspaceRecord("w", [columnOf([chatContent("a")])]));
    const removed = yield* removeThread({ workspaceId: "w", threadId: "a", environmentId });
    assert.deepEqual(removed.columns, []);
  }).pipe(Effect.provide(layerWorkspaces)),
);
