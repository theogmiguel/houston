import type { HoustonLayoutWorkspaceRecord } from "@houston-app/contracts/houston/layoutWorkspaces";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_LAYOUT_WORKSPACES_SNAPSHOT,
  applyLayoutWorkspaceStreamEvent,
} from "./layoutWorkspaces.ts";

const record = (id: string, revision: number): HoustonLayoutWorkspaceRecord => ({
  id,
  name: id,
  position: 0,
  columns: [],
  pinnedAt: null,
  hidden: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  revision,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("applyLayoutWorkspaceStreamEvent", () => {
  it("replaces everything on a snapshot and marks the list loaded", () => {
    const state = applyLayoutWorkspaceStreamEvent(EMPTY_LAYOUT_WORKSPACES_SNAPSHOT, {
      snapshot: { workspaces: [record("a", 1), record("b", 1)] },
    });
    expect(state.loaded).toBe(true);
    expect(state.workspaces.map((workspace) => workspace.id)).toEqual(["a", "b"]);
  });

  it("upserts by id, appending new workspaces and replacing known ones in place", () => {
    const loaded = applyLayoutWorkspaceStreamEvent(EMPTY_LAYOUT_WORKSPACES_SNAPSHOT, {
      snapshot: { workspaces: [record("a", 1), record("b", 1)] },
    });
    const replaced = applyLayoutWorkspaceStreamEvent(loaded, { upserted: record("a", 2) });
    expect(replaced.workspaces.map((w) => `${w.id}@${w.revision}`)).toEqual(["a@2", "b@1"]);
    const appended = applyLayoutWorkspaceStreamEvent(replaced, { upserted: record("c", 1) });
    expect(appended.workspaces.map((w) => w.id)).toEqual(["a", "b", "c"]);
  });

  it("drops a deleted workspace and keeps the same snapshot when the id is unknown", () => {
    const loaded = applyLayoutWorkspaceStreamEvent(EMPTY_LAYOUT_WORKSPACES_SNAPSHOT, {
      snapshot: { workspaces: [record("a", 1)] },
    });
    expect(applyLayoutWorkspaceStreamEvent(loaded, { deleted: { workspaceId: "zzz" } })).toBe(
      loaded,
    );
    expect(
      applyLayoutWorkspaceStreamEvent(loaded, { deleted: { workspaceId: "a" } }).workspaces,
    ).toEqual([]);
  });
});
