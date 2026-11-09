import { describe, expect, it } from "vite-plus/test";

import { resolveGridThreadOpen } from "./gridThreadOpen";
import { gridPreset } from "./tree";

const tree = gridPreset(["parent", "other"]);
const base = {
  tree,
  gridEnvironmentId: "env",
  environmentId: "env",
  fromThreadId: null,
  inWorkspace: true,
  intent: "peek",
  hasRoom: true,
} as const;

describe("resolveGridThreadOpen", () => {
  it("shows a subagent opened from its parent's cell in that cell instead of adding one", () => {
    expect(
      resolveGridThreadOpen({ ...base, threadId: "subagent", fromThreadId: "parent" }),
    ).toEqual({ kind: "replace", cellThreadId: "parent" });
  });

  it("brings the parent back into the subagent's cell even when it is not a listed thread", () => {
    const withSubagent = gridPreset(["subagent", "other"]);
    expect(
      resolveGridThreadOpen({
        ...base,
        tree: withSubagent,
        threadId: "parent",
        fromThreadId: "subagent",
        inWorkspace: false,
      }),
    ).toEqual({ kind: "replace", cellThreadId: "subagent" });
  });

  it("focuses a thread already on the grid", () => {
    expect(resolveGridThreadOpen({ ...base, threadId: "other", fromThreadId: "parent" })).toEqual({
      kind: "focus",
    });
  });

  it("adds a workspace thread opened from outside any cell, and navigates for anything else", () => {
    expect(resolveGridThreadOpen({ ...base, threadId: "new" })).toEqual({ kind: "add" });
    expect(resolveGridThreadOpen({ ...base, threadId: "new", inWorkspace: false })).toEqual({
      kind: "navigate",
    });
    expect(
      resolveGridThreadOpen({
        ...base,
        threadId: "x",
        environmentId: "elsewhere",
        fromThreadId: "parent",
      }),
    ).toEqual({ kind: "navigate" });
  });

  it("adds a resumed thread beside the cell that resumed it instead of replacing that cell", () => {
    expect(
      resolveGridThreadOpen({
        ...base,
        threadId: "resumed",
        fromThreadId: "parent",
        intent: "join",
      }),
    ).toEqual({ kind: "add" });
  });

  it("adds a resumed thread to an empty grid before its shell reaches the workspace list", () => {
    expect(
      resolveGridThreadOpen({
        ...base,
        tree: null,
        threadId: "resumed",
        inWorkspace: false,
        intent: "join",
      }),
    ).toEqual({ kind: "add" });
  });

  it("opens a resumed thread on its own page when the grid is full or in another environment", () => {
    expect(
      resolveGridThreadOpen({
        ...base,
        threadId: "resumed",
        fromThreadId: "parent",
        intent: "join",
        hasRoom: false,
      }),
    ).toEqual({ kind: "navigate" });
    expect(
      resolveGridThreadOpen({
        ...base,
        threadId: "resumed",
        environmentId: "elsewhere",
        intent: "join",
      }),
    ).toEqual({ kind: "navigate" });
  });
});
