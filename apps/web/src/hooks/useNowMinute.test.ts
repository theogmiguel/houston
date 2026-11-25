import { afterEach, describe, expect, it } from "vite-plus/test";

import { nowMinuteMs } from "./useNowMinute";

const zone = process.env.TZ;

describe("nowMinuteMs", () => {
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it("reads the minute tick as UTC whatever the local zone", () => {
    process.env.TZ = "America/Sao_Paulo";
    expect(nowMinuteMs("2026-11-25T12:33")).toBe(Date.UTC(2026, 10, 25, 12, 33));
  });
});
