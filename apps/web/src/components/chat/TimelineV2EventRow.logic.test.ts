import { describe, expect, it } from "vite-plus/test";

import {
  subagentGroupSummary,
  subagentGroupTiming,
  subagentStatusLabel,
} from "./TimelineV2EventRow.logic";

describe("subagentGroupSummary", () => {
  it("counts the group and each state, working first, separated by commas", () => {
    expect(subagentGroupSummary(["running", "completed", "pending"])).toEqual({
      title: "3 subagents",
      status: "2 working, 1 done",
      tone: "active",
    });
  });

  it("uses the singular and settles once nothing is working", () => {
    expect(subagentGroupSummary(["completed"])).toEqual({
      title: "1 subagent",
      status: "1 done",
      tone: "settled",
    });
  });

  it("marks a finished group with a failure", () => {
    expect(subagentGroupSummary(["completed", "failed", "cancelled", "idle"])).toEqual({
      title: "4 subagents",
      status: "1 done, 1 failed, 1 stopped, 1 idle",
      tone: "failed",
    });
  });
});

describe("subagentGroupTiming", () => {
  it("spans from the first start to the last finish once every agent is done", () => {
    expect(
      subagentGroupTiming([
        {
          status: "completed",
          startedAt: "2026-11-09T10:00:10.000Z",
          completedAt: "2026-11-09T10:02:00.000Z",
        },
        {
          status: "failed",
          startedAt: "2026-11-09T10:00:00.000Z",
          completedAt: "2026-11-09T10:01:00.000Z",
        },
      ]),
    ).toEqual({
      status: "completed",
      startedAt: "2026-11-09T10:00:00.000Z",
      completedAt: "2026-11-09T10:02:00.000Z",
    });
  });

  it("keeps running while any agent works, and has no time before any agent starts", () => {
    expect(
      subagentGroupTiming([
        {
          status: "completed",
          startedAt: "2026-11-09T10:00:00.000Z",
          completedAt: "2026-11-09T10:01:00.000Z",
        },
        { status: "running", startedAt: "2026-11-09T10:00:05.000Z", completedAt: null },
      ]),
    ).toEqual({ status: "running", startedAt: "2026-11-09T10:00:00.000Z", completedAt: null });
    expect(
      subagentGroupTiming([{ status: "pending", startedAt: null, completedAt: null }]),
    ).toEqual({ status: "pending", startedAt: null, completedAt: null });
  });
});

describe("subagentStatusLabel", () => {
  it("speaks the board's row states", () => {
    expect(subagentStatusLabel("completed")).toBe("Ready");
    expect(subagentStatusLabel("running")).toBe("Running");
    expect(subagentStatusLabel("failed")).toBe("Failed");
    expect(subagentStatusLabel("cancelled")).toBe("Stopped");
  });
});
