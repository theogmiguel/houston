import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  HoustonBot,
  HoustonBotRunSummary,
  HoustonBotSaveInput,
  HoustonBotStreamEvent,
} from "./bots.ts";

const decodeBot = Schema.decodeUnknownSync(HoustonBot);
const decodeEvent = Schema.decodeUnknownSync(HoustonBotStreamEvent);
const decodeSave = Schema.decodeUnknownExit(HoustonBotSaveInput);
const decodeRunSummary = Schema.decodeUnknownSync(HoustonBotRunSummary);

const bot = {
  id: "bot-1",
  slug: "digest",
  name: "Digest",
  mark: "D",
  job: "Writes the digest",
  defaultProjectId: "p1",
  otherProjectIds: ["p2"],
  modelSelection: { instanceId: "claudeAgent", model: "opus" },
  askedMode: "auto",
  unattendedFullAccess: false,
  maxAtOnce: 1,
  maxStartsPerDay: 6,
  maxMinutes: 20,
  enabled: false,
  readyMade: null,
  instructions: {
    n: 1,
    sha256: "0".repeat(64),
    acceptedAt: "2026-01-01T00:00:00.000Z",
    acceptedByLabel: "Laptop",
    restoredFrom: null,
  },
  recentChanges: [],
  rowRevision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("bot contracts", () => {
  it("decodes a change field this build does not know as other", () => {
    const change = (field: string) => ({
      field,
      at: "2026-01-01T00:00:00.000Z",
      byLabel: "Laptop",
    });
    const decoded = decodeBot({
      ...bot,
      recentChanges: [change("full_access"), change("a_later_field")],
    });
    expect(decoded.recentChanges.map((entry) => entry.field)).toEqual(["full_access", "other"]);
  });

  it("ignores a field a newer server adds to a bot", () => {
    expect(decodeBot({ ...bot, addedLater: true })).not.toHaveProperty("addedLater");
  });

  it("decodes each stream event", () => {
    for (const event of [
      { off: true, stopping: 0 },
      { snapshot: { bots: [bot] } },
      { upserted: bot },
      { deleted: { botId: "bot-1" } },
    ]) {
      expect(Object.keys(decodeEvent(event))).toEqual(Object.keys(event));
    }
  });

  it("lets the store name a limit: an over-long value decodes", () => {
    const save = {
      target: null,
      name: "x".repeat(500),
      mark: "",
      job: "",
      instructions: "x".repeat(20_000),
      defaultProjectId: "p1",
      otherProjectIds: [],
      modelSelection: bot.modelSelection,
      askedMode: "auto",
      unattendedFullAccess: false,
      maxAtOnce: 99,
      maxStartsPerDay: 0,
      maxMinutes: 1.5,
    };
    expect(decodeSave(save)._tag).toBe("Success");
    expect(decodeSave({ ...save, askedMode: "yolo" })._tag).toBe("Failure");
  });

  it("decodes a bot run's kind and state this build does not know as other", () => {
    const summary = decodeRunSummary({
      id: "run-1",
      botId: "bot-1",
      botName: "Digest",
      kind: "scheduled-by-a-newer-server",
      projectId: "p1",
      threadId: "bot-run-1",
      revisionN: 2,
      state: "paused",
      reason: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
    });
    expect([summary.kind, summary.state]).toEqual(["other", "other"]);
    const known = decodeRunSummary({
      ...summary,
      kind: "asked",
      state: "finished",
    });
    expect([known.kind, known.state]).toEqual(["asked", "finished"]);
  });
});
