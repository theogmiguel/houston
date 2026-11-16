import { describe, expect, it } from "vite-plus/test";

import { shelfReturnAction } from "./shelfReturn";

const NOW = "2026-01-01T12:00:00.000Z";
const base = { snoozedUntil: null, settledOverride: null, archivedAt: null, deletedAt: null };

describe("shelfReturnAction", () => {
  it("wakes a thread held until later", () => {
    expect(shelfReturnAction({ ...base, snoozedUntil: "2026-01-02T00:00:00.000Z" }, NOW)).toBe(
      "wake",
    );
  });

  it("reopens a closed thread", () => {
    expect(shelfReturnAction({ ...base, settledOverride: "settled" }, NOW)).toBe("reopen");
  });

  it("does nothing for an open thread, a hold that already ended, or a removed one", () => {
    expect(shelfReturnAction(base, NOW)).toBeNull();
    expect(
      shelfReturnAction({ ...base, snoozedUntil: "2026-01-01T00:00:00.000Z" }, NOW),
    ).toBeNull();
    expect(
      shelfReturnAction({ ...base, settledOverride: "settled", deletedAt: NOW }, NOW),
    ).toBeNull();
  });
});
