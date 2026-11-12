import { describe, expect, it } from "vite-plus/test";

import {
  forgetThreadSettledByUser,
  markThreadSettledByUser,
  wasThreadSettledByUser,
} from "./settledByUser";

describe("settledByUser", () => {
  it("reports only the threads the user settled", () => {
    markThreadSettledByUser("env:a");
    expect(wasThreadSettledByUser("env:a")).toBe(true);
    expect(wasThreadSettledByUser("env:b")).toBe(false);
    forgetThreadSettledByUser("env:a");
  });

  it("forgets a thread that is reopened", () => {
    markThreadSettledByUser("env:c");
    forgetThreadSettledByUser("env:c");
    expect(wasThreadSettledByUser("env:c")).toBe(false);
  });
});
