import { describe, expect, it } from "vite-plus/test";

import { bulkDeleteConfirmation, buildBulkMenuItems, type BulkMenuInput } from "./sidebarBulkMenu";

const base: BulkMenuInput = {
  count: 3,
  closableCount: 3,
  holdable: true,
  presets: [{ id: "tomorrow", label: "Tomorrow", whenLabel: "9:00" }],
  regeneratableCount: 3,
};

describe("buildBulkMenuItems", () => {
  it("offers Close, Hold, Regenerate titles, Mark unread and Delete with the selection count", () => {
    const items = buildBulkMenuItems(base);
    expect(items.map((item) => item.label)).toEqual([
      "Close (3)",
      "Hold (3)",
      "Regenerate titles (3)",
      "Mark unread (3)",
      "Delete (3)",
    ]);
    expect(items.at(-1)?.destructive).toBe(true);
  });

  it("lists the hold presets and a custom time under Hold", () => {
    const hold = buildBulkMenuItems(base).find((item) => item.label === "Hold (3)");
    expect(hold?.children?.map((child) => [child.id, child.label])).toEqual([
      ["hold:tomorrow", "Tomorrow (9:00)"],
      ["hold:custom", "Custom…"],
    ]);
  });

  it("disables Close when every selected thread is already closed", () => {
    const close = buildBulkMenuItems({ ...base, closableCount: 0 })[0];
    expect(close).toMatchObject({ id: "close", disabled: true });
  });

  it("leaves out Hold when a selected thread cannot be held", () => {
    const labels = buildBulkMenuItems({ ...base, holdable: false }).map((item) => item.label);
    expect(labels).not.toContain("Hold (3)");
  });

  it("shows Regenerating… disabled while every title is already being regenerated", () => {
    const item = buildBulkMenuItems({ ...base, regeneratableCount: 0 }).find(
      (candidate) => candidate.id === "regenerate-title",
    );
    expect(item).toMatchObject({ label: "Regenerating… (3)", disabled: true });
  });
});

describe("bulkDeleteConfirmation", () => {
  it("names the count with the right plural", () => {
    expect(bulkDeleteConfirmation(1)).toContain("Delete 1 thread?");
    expect(bulkDeleteConfirmation(4)).toContain("Delete 4 threads?");
  });
});
