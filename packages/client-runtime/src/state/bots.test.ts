import type { HoustonBot } from "@houston-app/contracts/houston/bots";
import { describe, expect, it } from "vite-plus/test";

import { applyBotStreamEvent, EMPTY_BOTS_SNAPSHOT } from "./bots.ts";

const bot = (id: string, rowRevision: number) => ({ id, rowRevision }) as HoustonBot;

describe("applyBotStreamEvent", () => {
  const loaded = applyBotStreamEvent(EMPTY_BOTS_SNAPSHOT, {
    snapshot: { bots: [bot("a", 2), bot("b", 1)] },
  });

  it("is loading until the first event, then on", () => {
    expect(EMPTY_BOTS_SNAPSHOT.state).toBe("loading");
    expect(loaded.state).toBe("on");
    expect(loaded.bots.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("appends a new bot, replaces a known one in place and drops an older change", () => {
    const added = applyBotStreamEvent(loaded, { upserted: bot("c", 1) });
    expect(added.bots.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    const changed = applyBotStreamEvent(added, { upserted: bot("a", 3) });
    expect(changed.bots.map((entry) => entry.rowRevision)).toEqual([3, 1, 1]);
    expect(applyBotStreamEvent(changed, { upserted: bot("a", 2) })).toBe(changed);
  });

  it("drops a deleted bot, and every bot when the switch is turned off", () => {
    const without = applyBotStreamEvent(loaded, { deleted: { botId: "a" } });
    expect(without.bots.map((entry) => entry.id)).toEqual(["b"]);
    expect(applyBotStreamEvent(without, { off: true, stopping: 2 })).toEqual({
      state: "off",
      stopping: 2,
      bots: [],
    });
  });
});
