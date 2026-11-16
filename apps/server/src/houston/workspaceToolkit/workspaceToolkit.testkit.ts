// Doubles and builders for the workspace tools' tests: a workspace service that holds nothing, the
// real service over an in-memory database, and records to seed it with.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import type {
  HoustonLayoutColumn,
  HoustonLayoutTabContent,
  HoustonLayoutWorkspaceRecord,
} from "@houston-app/contracts/houston/layoutWorkspaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as HoustonLayoutWorkspaces from "../layoutWorkspaces.ts";

/** A workspace service with no workspaces; any other operation is a defect, so a test that needs one says so. */
export const layerNoWorkspaces = Layer.mock(HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService)({
  list: Effect.succeed([]),
});

export const WORKSPACE_TEST_ENVIRONMENT = "environment-workspace-tools";

/** The real workspace service over a fresh in-memory database. */
export const layerWorkspaces = HoustonLayoutWorkspaces.layer.pipe(
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(NodeCrypto.layer),
);

export const chatContent = (
  threadId: string,
  environmentId = WORKSPACE_TEST_ENVIRONMENT,
): HoustonLayoutTabContent => ({
  kind: "chat",
  target: { kind: "server", threadRef: { environmentId, threadId } },
});

export const surfaceContent = (
  threadId: string,
  surfaceId = "diff",
  environmentId = WORKSPACE_TEST_ENVIRONMENT,
): HoustonLayoutTabContent => ({
  kind: "surface",
  threadRef: { environmentId, threadId },
  surfaceId,
});

let counter = 0;
const unique = (prefix: string) => `${prefix}-${(counter += 1)}`;

/** One column holding one pane per entry; each pane holds the given tabs. */
export const columnOf = (...tabsPerPane: HoustonLayoutTabContent[][]): HoustonLayoutColumn => ({
  id: unique("column"),
  width: 1,
  panes: tabsPerPane.map((contents) => {
    const tabs = contents.map((content) => ({ id: unique("tab"), content }));
    return { id: unique("pane"), size: 1 / tabsPerPane.length, activeTabId: tabs[0]!.id, tabs };
  }),
});

export const workspaceRecord = (
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

/** Saves `record` as a new workspace and returns it as stored. */
export const seedWorkspace = (record: HoustonLayoutWorkspaceRecord) =>
  Effect.gen(function* () {
    const service = yield* HoustonLayoutWorkspaces.HoustonLayoutWorkspaceService;
    const result = yield* service.put({ workspace: record, expectedRevision: 0 });
    if (result.status !== "saved") {
      return yield* Effect.die(`seeding workspace '${record.id}' conflicted`);
    }
    return result.workspace;
  });

/** The chat thread ids of a workspace in column, pane and tab order. */
export const chatThreadsOf = (workspace: HoustonLayoutWorkspaceRecord): ReadonlyArray<string> =>
  workspace.columns.flatMap((column) =>
    column.panes.flatMap((pane) =>
      pane.tabs.flatMap((tab) =>
        tab.content.kind === "chat" && tab.content.target.kind === "server"
          ? [tab.content.target.threadRef.threadId]
          : [],
      ),
    ),
  );
