import { describe, expect, it } from "vite-plus/test";
import { resolveBlockedThreadStatus } from "./TimelineWorkGroupRows.logic";

describe("resolveBlockedThreadStatus", () => {
  it("keeps the sidebar's needs label for a turn waiting on the user", () => {
    expect(resolveBlockedThreadStatus({ label: "Needs you", state: "needs" })).toEqual({
      label: "Needs you",
      state: "needs",
    });
    expect(resolveBlockedThreadStatus({ label: "Pending Approval", state: "needs" })).toEqual({
      label: "Pending Approval",
      state: "needs",
    });
  });

  it("leaves every other status to the running mark", () => {
    expect(resolveBlockedThreadStatus({ label: "Running", state: "running" })).toBeNull();
    expect(resolveBlockedThreadStatus({ label: "Ready", state: "ready" })).toBeNull();
    expect(resolveBlockedThreadStatus({ label: "Failed", state: "failed" })).toBeNull();
    expect(resolveBlockedThreadStatus(null)).toBeNull();
  });
});
