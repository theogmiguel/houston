import { describe, expect, it } from "vite-plus/test";

import {
  THREAD_DROP_REFUSAL_LABEL,
  crossProjectMoveToast,
  gridFullMoveToast,
  noProjectMoveToast,
  sameProject,
  threadDropRefusal,
} from "./projectMove";

const GRID = { environmentId: "env-1", projectId: "project-1" };

describe("threadDropRefusal", () => {
  it("refuses a thread from another project even at the centre", () => {
    expect(
      threadDropRefusal({
        threadProject: { environmentId: "env-1", projectId: "project-2" },
        grid: GRID,
        side: "center",
        sourceInTarget: false,
        targetCount: 0,
        maxThreads: 6,
      }),
    ).toBe("different-project");
  });

  it("refuses a growing edge drop at the cap but allows a centre replace", () => {
    const input = {
      threadProject: GRID,
      grid: GRID,
      sourceInTarget: false,
      targetCount: 6,
      maxThreads: 6,
    } as const;
    expect(threadDropRefusal({ ...input, side: "left" })).toBe("grid-full");
    expect(threadDropRefusal({ ...input, side: "center" })).toBeNull();
  });

  it("allows an edge drop of a thread the grid already shows at the cap", () => {
    expect(
      threadDropRefusal({
        threadProject: GRID,
        grid: GRID,
        side: "right",
        sourceInTarget: true,
        targetCount: 6,
        maxThreads: 6,
      }),
    ).toBeNull();
  });
});

describe("drop copy", () => {
  it("names the reason in the zone", () => {
    expect(THREAD_DROP_REFUSAL_LABEL["different-project"]).toBe("Different project");
    expect(THREAD_DROP_REFUSAL_LABEL["grid-full"]).toBe("Grid full");
  });

  it("names the limit, the count and the grid", () => {
    const toast = gridFullMoveToast("Review", 6, 6);
    expect(toast.description).toContain("at most 6");
    expect(toast.description).toContain("already shows 6");
    expect(toast.title).toContain("Review");
  });

  it("names both projects when the thread crosses one", () => {
    const toast = crossProjectMoveToast("Houston", "Intranet");
    expect(toast.description).toContain("Houston");
    expect(toast.description).toContain("Intranet");
  });

  it("says a thread without a project cannot join a grid", () => {
    expect(noProjectMoveToast("Review").description).toContain("Review");
  });

  it("compares environment and project together", () => {
    expect(sameProject(GRID, { environmentId: "env-1", projectId: "project-1" })).toBe(true);
    expect(sameProject(GRID, { environmentId: "env-2", projectId: "project-1" })).toBe(false);
  });
});
