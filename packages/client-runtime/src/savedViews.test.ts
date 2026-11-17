import { describe, expect, it } from "vite-plus/test";

import { savedViewNameError } from "./savedViews.ts";

const views = [{ id: "assigned", name: "Issues Assigned to Me" }];

describe("savedViewNameError", () => {
  it("rejects blank, oversized and duplicate names while allowing a view to keep its own", () => {
    expect(savedViewNameError("   ", views)).toBeTruthy();
    expect(savedViewNameError("x".repeat(81), views)).toBeTruthy();
    expect(savedViewNameError("  ISSUES ASSIGNED TO ME  ", views)).toBeTruthy();
    expect(savedViewNameError("Issues Assigned to Me", views, "assigned")).toBeNull();
    expect(savedViewNameError("  Triage  ", views)).toBeNull();
  });
});
