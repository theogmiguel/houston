import { describe, expect, it } from "vite-plus/test";

import {
  houston1ImportDescription,
  houston1ImportSteps,
  houston1ImportVisible,
} from "./houston1Import.logic";

const tasksAvailable = {
  state: "available" as const,
  source: "/home/x/.houston/houston.db",
  taskCount: 3,
  workspaceCount: 2,
};

describe("Houston 1 import", () => {
  it("runs only the imports that still have data", () => {
    expect(
      houston1ImportSteps({
        tasks: tasksAvailable,
        issues: {
          state: "imported",
          at: "2026-01-01T00:00:00.000Z",
          counts: { links: 2, skipped: 0 },
        },
        slack: { state: "unavailable" },
      }),
    ).toEqual(["tasks"]);
  });

  it("describes every copyable kind in one sentence", () => {
    expect(
      houston1ImportDescription({
        tasks: tasksAvailable,
        issues: { state: "available", source: "/db", links: 2 },
        slack: { state: "available", source: "/db", channels: 1, requests: 4 },
      }),
    ).toBe(
      "Houston can copy 2 projects and 3 tasks from Houston 1; 2 Notion page links; 1 Slack channel and 4 requests.",
    );
  });

  it("stays hidden when there is no Houston 1 data", () => {
    expect(
      houston1ImportVisible({ tasks: { state: "unavailable" }, issues: null, slack: null }),
    ).toBe(false);
  });

  it("explains a blocked task import instead of offering a retry", () => {
    expect(
      houston1ImportSteps({
        tasks: { state: "blocked", taskCount: 2 },
        issues: null,
        slack: null,
      }),
    ).toEqual([]);
    expect(
      houston1ImportDescription({
        tasks: { state: "blocked", taskCount: 2 },
        issues: null,
        slack: null,
      }),
    ).toContain("already has tasks");
  });
});
