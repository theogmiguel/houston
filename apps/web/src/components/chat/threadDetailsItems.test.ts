import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadDetailsVisibility,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
} from "./threadDetailsItems";

const usage = THREAD_DETAILS_ITEMS.find((item) => item.id === "usage")!;
const memory = THREAD_DETAILS_ITEMS.find((item) => item.id === "memory")!;
const servers = THREAD_DETAILS_ITEMS.find((item) => item.id === "servers")!;

describe("thread details items", () => {
  it.each([
    { legacy: false, items: {}, usage: false },
    { legacy: true, items: {}, usage: true },
    { legacy: true, items: { usage: false }, usage: false },
    { legacy: false, items: { usage: true, retired: false }, usage: true },
  ])("resolves Usage from overrides and the retired Labs flag: %o", (row) => {
    const visibility = resolveThreadDetailsVisibility({
      threadDetailsItems: row.items,
      threadDetailsUsageEnabled: row.legacy,
    });
    expect(visibility.usage).toBe(row.usage);
    expect(visibility.memory).toBe(false);
    expect(visibility.servers).toBe(true);
  });

  it("lists the Memory item after Usage, off by default", () => {
    const usageIndex = THREAD_DETAILS_ITEMS.findIndex((item) => item.id === "usage");
    const memoryIndex = THREAD_DETAILS_ITEMS.findIndex((item) => item.id === "memory");
    expect(memoryIndex).toBe(usageIndex + 1);
    expect(memory.defaultVisible).toBe(false);
  });

  it("stores only choices that differ from the default", () => {
    const legacyOn = { threadDetailsItems: {}, threadDetailsUsageEnabled: true };
    expect(setThreadDetailsItem(legacyOn, usage, false)).toEqual({ usage: false });
    expect(setThreadDetailsItem(legacyOn, usage, true)).toEqual({});
    expect(setThreadDetailsItem(legacyOn, memory, true)).toEqual({ memory: true });
    expect(setThreadDetailsItem(legacyOn, memory, false)).toEqual({});

    const hidden = { threadDetailsItems: { servers: false }, threadDetailsUsageEnabled: false };
    expect(setThreadDetailsItem(hidden, servers, true)).toEqual({});
  });
});
