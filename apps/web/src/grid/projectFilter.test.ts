import { describe, expect, it } from "vite-plus/test";

import {
  activeProjectFilterKeys,
  applyProjectFilter,
  groupContainsWorkspace,
  nextProjectFilterKeys,
} from "./projectFilter";

const groups = [{ projectKey: "a" }, { projectKey: "b" }, { projectKey: "c" }];

describe("applyProjectFilter", () => {
  it("keeps every project when nothing is chosen", () => {
    expect(applyProjectFilter(groups, [])).toEqual(groups);
  });

  it("keeps the chosen projects in the rail's order", () => {
    expect(applyProjectFilter(groups, ["c", "a"]).map((group) => group.projectKey)).toEqual([
      "a",
      "c",
    ]);
  });

  it("shows every project when the chosen ones no longer exist", () => {
    expect(applyProjectFilter(groups, ["gone"])).toEqual(groups);
  });
});

describe("activeProjectFilterKeys", () => {
  it("drops stored keys with no project", () => {
    expect(activeProjectFilterKeys(groups, ["gone", "b"])).toEqual(["b"]);
    expect(activeProjectFilterKeys(groups, [])).toEqual([]);
  });
});

describe("nextProjectFilterKeys", () => {
  it("chooses one project on a plain click", () => {
    expect(nextProjectFilterKeys(["a", "b"], "c", false)).toEqual(["c"]);
  });

  it("clears the filter when the only chosen project is clicked again", () => {
    expect(nextProjectFilterKeys(["a"], "a", false)).toEqual([]);
  });

  it("narrows a many-project choice to the clicked project", () => {
    expect(nextProjectFilterKeys(["a", "b"], "a", false)).toEqual(["a"]);
  });

  it("adds and removes projects on Shift-click", () => {
    expect(nextProjectFilterKeys(["a"], "b", true)).toEqual(["a", "b"]);
    expect(nextProjectFilterKeys(["a", "b"], "a", true)).toEqual(["b"]);
  });

  it("clears the filter from All projects", () => {
    expect(nextProjectFilterKeys(["a", "b"], null, true)).toEqual([]);
  });
});

describe("groupContainsWorkspace", () => {
  it("matches on environment and project", () => {
    const group = { memberProjectRefs: [{ environmentId: "e1", projectId: "p1" }] } as never;
    expect(groupContainsWorkspace(group, { environmentId: "e1", projectId: "p1" })).toBe(true);
    expect(groupContainsWorkspace(group, { environmentId: "e2", projectId: "p1" })).toBe(false);
  });
});
