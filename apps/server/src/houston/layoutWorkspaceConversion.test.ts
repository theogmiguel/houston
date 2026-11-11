// Grid trees converted to columns of panes: the shapes that convert exactly and the ones that
// flatten, which must say so.
import { assert, describe, it } from "@effect/vitest";
import { findLayoutViolation } from "@houston-app/contracts/houston/layoutWorkspaces";

import { convertGridTree, type LegacyGridNode } from "./layoutWorkspaceConversion.ts";

const leaf = (threadId: string, extra: { draftId?: string } = {}): LegacyGridNode => ({
  kind: "thread",
  threadId,
  id: `leaf-${threadId}`,
  ...extra,
});
const split = (
  dir: "row" | "col",
  children: LegacyGridNode[],
  weights: number[] = children.map(() => 1),
): LegacyGridNode => ({ kind: "split", dir, children, weights });

const convert = (tree: LegacyGridNode | null, claimed = new Set<string>()) =>
  convertGridTree({ gridId: "g1", environmentId: "env", tree, claimedThreadIds: claimed });

const threadsOf = (result: ReturnType<typeof convert>) =>
  result.columns.map((column) =>
    column.panes.map((pane) =>
      pane.tabs.map((tab) =>
        tab.content.kind === "chat" && tab.content.target.kind === "server"
          ? tab.content.target.threadRef.threadId
          : "?",
      ),
    ),
  );

describe("shapes that convert exactly", () => {
  it("no tree is a workspace without columns", () => {
    const result = convert(null);
    assert.deepEqual(result.columns, []);
    assert.deepEqual(result.notes, []);
  });

  it("a single leaf is one column of one pane with one chat tab", () => {
    const result = convert(leaf("a"));
    assert.deepEqual(threadsOf(result), [[["a"]]]);
    assert.deepEqual(result.notes, []);
    assert.equal(result.columns[0]!.width, 1);
    assert.equal(result.columns[0]!.panes[0]!.size, 1);
    assert.equal(
      result.columns[0]!.panes[0]!.activeTabId,
      result.columns[0]!.panes[0]!.tabs[0]!.id,
    );
    assert.deepEqual(result.columns[0]!.panes[0]!.tabs[0]!.content, {
      kind: "chat",
      target: { kind: "server", threadRef: { environmentId: "env", threadId: "a" } },
    });
  });

  it("a root row of leaves is n columns whose widths follow the weights", () => {
    const result = convert(split("row", [leaf("a"), leaf("b")], [1, 3]));
    assert.deepEqual(threadsOf(result), [[["a"]], [["b"]]]);
    assert.deepEqual(
      result.columns.map((column) => column.width),
      [0.25, 0.75],
    );
    assert.deepEqual(result.notes, []);
  });

  it("a root col of leaves is one column of n panes whose sizes follow the weights", () => {
    const result = convert(split("col", [leaf("a"), leaf("b"), leaf("c")], [1, 1, 2]));
    assert.deepEqual(threadsOf(result), [[["a"], ["b"], ["c"]]]);
    assert.deepEqual(
      result.columns[0]!.panes.map((pane) => pane.size),
      [0.25, 0.25, 0.5],
    );
    assert.deepEqual(result.notes, []);
  });

  it("a root row whose children are leaves or col splits of leaves keeps its columns of panes", () => {
    const result = convert(
      split("row", [leaf("a"), split("col", [leaf("b"), leaf("c")], [1, 3])], [1, 1]),
    );
    assert.deepEqual(threadsOf(result), [[["a"]], [["b"], ["c"]]]);
    assert.deepEqual(
      result.columns[1]!.panes.map((pane) => pane.size),
      [0.25, 0.75],
    );
    assert.deepEqual(result.notes, []);
  });

  it("a leaf's draft id is dropped and the leaf stays a thread tab", () => {
    const result = convert(leaf("a", { draftId: "d1" }));
    assert.deepEqual(threadsOf(result), [[["a"]]]);
    assert.deepEqual(result.notes, []);
  });

  it("every converted layout satisfies the contract's rules", () => {
    const result = convert(split("row", [leaf("a"), split("col", [leaf("b"), leaf("c")])]));
    assert.isUndefined(findLayoutViolation(result));
  });

  it("converting twice gives the same ids", () => {
    const tree = split("row", [leaf("a"), split("col", [leaf("b"), leaf("c")])]);
    assert.deepEqual(convert(tree), convert(tree));
  });

  it("two grids never share a column, pane or tab id", () => {
    const tree = split("row", [leaf("a"), leaf("b")]);
    const first = convertGridTree({
      gridId: "g1",
      environmentId: "env",
      tree,
      claimedThreadIds: new Set(),
    });
    const second = convertGridTree({
      gridId: "g2",
      environmentId: "env",
      tree,
      claimedThreadIds: new Set(),
    });
    const idsOf = (result: typeof first) =>
      result.columns.flatMap((column) => [
        column.id,
        ...column.panes.flatMap((pane) => [pane.id, ...pane.tabs.map((tab) => tab.id)]),
      ]);
    const overlap = idsOf(first).filter((id) => idsOf(second).includes(id));
    assert.deepEqual(overlap, []);
  });
});

describe("shapes that lose structure flatten in preorder with equal sizes and say so", () => {
  it("col(row(a,b), row(c,d)), the four-thread preset", () => {
    const result = convert(
      split("col", [split("row", [leaf("a"), leaf("b")]), split("row", [leaf("c"), leaf("d")])]),
    );
    assert.deepEqual(threadsOf(result), [[["a"], ["b"], ["c"], ["d"]]]);
    assert.deepEqual(
      result.columns[0]!.panes.map((pane) => pane.size),
      [0.25, 0.25, 0.25, 0.25],
    );
    assert.lengthOf(result.notes, 1);
    assert.match(result.notes[0]!, /flattened 4 threads/);
  });

  it("col(row(a,b,c), row(d,e,f)), the six-thread preset", () => {
    const result = convert(
      split("col", [
        split("row", [leaf("a"), leaf("b"), leaf("c")]),
        split("row", [leaf("d"), leaf("e"), leaf("f")]),
      ]),
    );
    assert.deepEqual(threadsOf(result), [[["a"], ["b"], ["c"], ["d"], ["e"], ["f"]]]);
    assert.lengthOf(result.notes, 1);
  });

  it("row(a, col(row(b,c), row(d,e))), the five-thread preset", () => {
    const result = convert(
      split("row", [
        leaf("a"),
        split("col", [split("row", [leaf("b"), leaf("c")]), split("row", [leaf("d"), leaf("e")])]),
      ]),
    );
    assert.deepEqual(threadsOf(result), [[["a"]], [["b"], ["c"], ["d"], ["e"]]]);
    assert.lengthOf(result.notes, 1);
    assert.match(result.notes[0]!, /column 2/);
  });

  it("a col of unequal arity, col(row(a,b), c)", () => {
    const result = convert(split("col", [split("row", [leaf("a"), leaf("b")]), leaf("c")]));
    assert.deepEqual(threadsOf(result), [[["a"], ["b"], ["c"]]]);
    assert.lengthOf(result.notes, 1);
  });

  it("an alternation row > col > row at depth three", () => {
    const result = convert(
      split("row", [split("col", [split("row", [leaf("a"), leaf("b")]), leaf("c")]), leaf("d")]),
    );
    assert.deepEqual(threadsOf(result), [[["a"], ["b"], ["c"]], [["d"]]]);
    assert.lengthOf(result.notes, 1);
    assert.match(result.notes[0]!, /column 1/);
  });

  it("a row nested directly in the root row", () => {
    const result = convert(split("row", [leaf("a"), split("row", [leaf("b"), leaf("c")])]));
    assert.deepEqual(threadsOf(result), [[["a"]], [["b"], ["c"]]]);
    assert.lengthOf(result.notes, 1);
  });

  it("each flattened column is named in the notes", () => {
    const result = convert(
      split("row", [
        split("col", [split("row", [leaf("a"), leaf("b")]), leaf("c")]),
        split("col", [split("row", [leaf("d"), leaf("e")]), leaf("f")]),
      ]),
    );
    assert.lengthOf(result.notes, 2);
    assert.match(result.notes[0]!, /column 1/);
    assert.match(result.notes[1]!, /column 2/);
  });
});

describe("a thread already placed in an earlier workspace", () => {
  it("is dropped and named, and the claim is recorded", () => {
    const claimed = new Set<string>(["env\u0000a"]);
    const result = convert(split("row", [leaf("a"), leaf("b")]), claimed);
    assert.deepEqual(threadsOf(result), [[["b"]]]);
    assert.equal(result.columns[0]!.width, 1);
    assert.lengthOf(result.notes, 1);
    assert.match(result.notes[0]!, /thread a/);
    assert.isTrue(claimed.has("env\u0000b"));
  });

  it("empties the workspace when every thread was claimed", () => {
    const result = convert(leaf("a"), new Set(["env\u0000a"]));
    assert.deepEqual(result.columns, []);
    assert.lengthOf(result.notes, 1);
  });
});
