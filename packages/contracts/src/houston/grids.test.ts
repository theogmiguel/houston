import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  HOUSTON_GRID_LIMITS,
  HoustonGridPlaceThreadInput,
  HoustonGridPutInput,
  HoustonGridRecord,
  HoustonGridStreamEvent,
} from "./grids.ts";

const accepts = (schema: Schema.Top, value: unknown) =>
  Schema.decodeUnknownExit(schema as Schema.Codec<unknown, unknown>)(value)._tag === "Success";

const leaf = (n: number) => ({ kind: "thread", threadId: `t${n}`, id: `p${n}` });
const row = (leaves: number) => ({
  kind: "split",
  dir: "row",
  children: Array.from({ length: leaves }, (_, n) => leaf(n)),
  weights: Array.from({ length: leaves }, () => 1),
});
const record = (overrides: Record<string, unknown> = {}) => ({
  id: "g1",
  environmentId: "env",
  projectId: "p1",
  workspaceKey: "env:p1",
  name: "Grid 1",
  tree: null,
  pinnedAt: null,
  hidden: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  revision: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});
const nested = (depth: number): unknown =>
  depth === 0
    ? leaf(0)
    : { kind: "split", dir: "col", children: [nested(depth - 1)], weights: [1] };

describe("grid record bounds", () => {
  it("accepts an empty grid, one leaf and a full split", () => {
    expect(accepts(HoustonGridRecord, record())).toBe(true);
    expect(accepts(HoustonGridRecord, record({ tree: leaf(0) }))).toBe(true);
    expect(accepts(HoustonGridRecord, record({ tree: row(HOUSTON_GRID_LIMITS.threads) }))).toBe(
      true,
    );
  });

  it("refuses a name over the limit and a blank name", () => {
    expect(
      accepts(HoustonGridRecord, record({ name: "x".repeat(HOUSTON_GRID_LIMITS.nameChars) })),
    ).toBe(true);
    expect(
      accepts(HoustonGridRecord, record({ name: "x".repeat(HOUSTON_GRID_LIMITS.nameChars + 1) })),
    ).toBe(false);
    expect(accepts(HoustonGridRecord, record({ name: "   " }))).toBe(false);
  });

  it("refuses more thread leaves than a grid holds", () => {
    expect(accepts(HoustonGridRecord, record({ tree: row(HOUSTON_GRID_LIMITS.threads + 1) }))).toBe(
      false,
    );
  });

  it("refuses a tree deeper than the bound", () => {
    expect(
      accepts(HoustonGridRecord, record({ tree: nested(HOUSTON_GRID_LIMITS.treeDepth - 1) })),
    ).toBe(true);
    expect(
      accepts(HoustonGridRecord, record({ tree: nested(HOUSTON_GRID_LIMITS.treeDepth) })),
    ).toBe(false);
  });

  it("refuses a split whose weights do not match its children or are not positive", () => {
    const base = row(2);
    expect(accepts(HoustonGridRecord, record({ tree: { ...base, weights: [1] } }))).toBe(false);
    expect(accepts(HoustonGridRecord, record({ tree: { ...base, weights: [1, 0] } }))).toBe(false);
    expect(
      accepts(HoustonGridRecord, record({ tree: { ...base, children: [], weights: [] } })),
    ).toBe(false);
  });

  it("refuses the same thread twice in one tree", () => {
    const twice = { ...row(2), children: [leaf(0), { ...leaf(1), threadId: "t0" }] };
    expect(accepts(HoustonGridRecord, record({ tree: twice }))).toBe(false);
  });

  it("refuses a negative revision", () => {
    expect(accepts(HoustonGridRecord, record({ revision: -1 }))).toBe(false);
  });
});

describe("grid inputs and stream", () => {
  it("a put names the revision the client read", () => {
    expect(accepts(HoustonGridPutInput, { grid: record(), expectedRevision: 0 })).toBe(true);
    expect(accepts(HoustonGridPutInput, { grid: record() })).toBe(false);
  });

  it("place-thread needs a grid and a thread", () => {
    expect(accepts(HoustonGridPlaceThreadInput, { gridId: "g", threadId: "t" })).toBe(true);
    expect(accepts(HoustonGridPlaceThreadInput, { gridId: "g" })).toBe(false);
  });

  it("the stream opens with a snapshot and then carries upserts and deletions", () => {
    expect(accepts(HoustonGridStreamEvent, { snapshot: { grids: [record()] } })).toBe(true);
    expect(accepts(HoustonGridStreamEvent, { upserted: record() })).toBe(true);
    expect(accepts(HoustonGridStreamEvent, { deleted: { gridId: "g1", projectId: "p1" } })).toBe(
      true,
    );
    expect(accepts(HoustonGridStreamEvent, { deleted: {} })).toBe(false);
  });
});
