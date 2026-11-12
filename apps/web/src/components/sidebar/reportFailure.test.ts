import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const added = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../ui/toast", () => ({
  toastManager: { add: (toast: Record<string, unknown>) => added.push(toast) },
  stackedThreadToast: (toast: Record<string, unknown>) => toast,
}));

import { reportFailure } from "./reportFailure";

describe("reportFailure", () => {
  beforeEach(() => {
    added.length = 0;
  });

  it("shows the server's error text under the title", () => {
    const failed = reportFailure(
      "Failed to rename thread",
      AsyncResult.failure(Cause.fail(new Error("Title is longer than 200 characters."))) as never,
    );
    expect(failed).toBe(true);
    expect(added).toEqual([
      {
        type: "error",
        title: "Failed to rename thread",
        description: "Title is longer than 200 characters.",
      },
    ]);
  });

  it("falls back to a generic description for a failure that is not an Error", () => {
    reportFailure("Failed to rename thread", AsyncResult.failure(Cause.fail("nope")) as never);
    expect(added[0]?.description).toBe("An error occurred.");
  });

  it("reports nothing for a success", () => {
    expect(reportFailure("Failed to rename thread", AsyncResult.success(1) as never)).toBe(false);
    expect(added).toEqual([]);
  });
});
