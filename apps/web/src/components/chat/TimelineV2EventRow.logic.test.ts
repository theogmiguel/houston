import { describe, expect, it } from "vite-plus/test";

import { subagentGroupSummaryText, subagentStatusLabel } from "./TimelineV2EventRow.logic";

describe("subagentGroupSummaryText", () => {
  it("counts started subagents and live ones", () => {
    expect(
      subagentGroupSummaryText(["completed", "running", "completed"]),
    ).toEqual({ label: "Started 3 subagents", running: "1 running" });
  });

  it("uses the singular and drops the running suffix once every subagent is ready", () => {
    expect(subagentGroupSummaryText(["completed"])).toEqual({
      label: "Started 1 subagent",
      running: null,
    });
    expect(subagentGroupSummaryText(["completed", "failed"])).toEqual({
      label: "Started 2 subagents",
      running: null,
    });
  });

  it("counts queued and waiting subagents as running", () => {
    expect(subagentGroupSummaryText(["pending", "waiting"])).toEqual({
      label: "Started 2 subagents",
      running: "2 running",
    });
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
