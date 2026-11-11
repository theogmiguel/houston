import type { HoustonGridRecord } from "@houston-app/contracts/houston/grids";
import { describe, expect, it } from "vite-plus/test";

import { EMPTY_GRIDS_SNAPSHOT, applyGridStreamEvent } from "./grids.ts";

const record = (id: string, revision: number): HoustonGridRecord => ({
  id,
  environmentId: "env-1",
  projectId: "project-1",
  workspaceKey: "env-1:project-1",
  name: id,
  tree: null,
  pinnedAt: null,
  hidden: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  revision,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("applyGridStreamEvent", () => {
  it("replaces everything on a snapshot and marks the list loaded", () => {
    const state = applyGridStreamEvent(EMPTY_GRIDS_SNAPSHOT, {
      snapshot: { grids: [record("a", 1), record("b", 1)] },
    });
    expect(state.loaded).toBe(true);
    expect(state.grids.map((grid) => grid.id)).toEqual(["a", "b"]);
    expect(applyGridStreamEvent(state, { snapshot: { grids: [record("c", 1)] } }).grids).toEqual([
      record("c", 1),
    ]);
  });

  it("upserts by id, appending new grids and replacing known ones in place", () => {
    const loaded = applyGridStreamEvent(EMPTY_GRIDS_SNAPSHOT, {
      snapshot: { grids: [record("a", 1), record("b", 1)] },
    });
    const replaced = applyGridStreamEvent(loaded, { upserted: record("a", 2) });
    expect(replaced.grids.map((grid) => `${grid.id}@${grid.revision}`)).toEqual(["a@2", "b@1"]);
    const appended = applyGridStreamEvent(replaced, { upserted: record("c", 1) });
    expect(appended.grids.map((grid) => grid.id)).toEqual(["a", "b", "c"]);
  });

  it("drops a deleted grid and keeps the same state for an unknown one", () => {
    const loaded = applyGridStreamEvent(EMPTY_GRIDS_SNAPSHOT, {
      snapshot: { grids: [record("a", 1)] },
    });
    expect(
      applyGridStreamEvent(loaded, { deleted: { gridId: "a", projectId: "project-1" } }).grids,
    ).toEqual([]);
    expect(applyGridStreamEvent(loaded, { deleted: { gridId: "zz", projectId: "p" } })).toBe(
      loaded,
    );
  });
});
