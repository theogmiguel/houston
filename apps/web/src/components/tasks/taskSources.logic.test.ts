import type { HoustonTaskSourceSettings } from "@houston-app/contracts/houston/taskSources";
import type { HoustonSlackInfo, HoustonSlackRequest } from "@houston-app/contracts/houston/slack";
import { describe, expect, it } from "vite-plus/test";

import {
  blankToNull,
  conflictSummary,
  joinStatusValues,
  parseStatusValues,
  settingsInputFrom,
  slackConnectionState,
  slackRequestLabel,
  taskSourceState,
} from "./taskSources.logic";

const SETTINGS: HoustonTaskSourceSettings = {
  projectId: "p1" as never,
  provider: "notion",
  enabled: true,
  revision: 3,
  githubRepository: "octo/project",
  githubLabel: null,
  githubAssignedUser: null,
  notionDataSourceId: "data-source",
  notionTitlePropertyId: null,
  notionDescriptionPropertyId: null,
  notionStatusPropertyId: null,
  notionAssigneePropertyId: null,
  notionProjectRelationPropertyId: null,
  notionAssigneeUserId: null,
  notionActiveStatusValues: ["Todo"],
  notionProjectsDataSourceId: null,
  notionProjectTitlePropertyId: null,
  notionProjectDescriptionPropertyId: null,
  notionPrUrlPropertyId: null,
  notionStatusMapping: {
    todo: "Todo",
    inProgress: null,
    inReview: null,
    done: "Done",
    canceled: null,
  },
  hasCredential: true,
  lastSyncAt: "2026-01-01T00:00:00.000Z",
  lastError: null,
};

function slackInfo(patch: Partial<HoustonSlackInfo>): HoustonSlackInfo {
  return {
    enabled: true,
    hasTokens: true,
    connection: "connected",
    team: "cdv-eng",
    botUserId: null,
    ownerUserId: null,
    channels: [],
    language: "en",
    lastEventAt: null,
    lastCatchupAt: null,
    error: null,
    revision: 1,
    ...patch,
  };
}

function request(patch: Partial<HoustonSlackRequest>): HoustonSlackRequest {
  return {
    taskId: 1,
    projectId: "p1" as never,
    author: "maria",
    channelId: "C1",
    state: "pending",
    permalink: null,
    statusReaction: null,
    ...patch,
  };
}

describe("conflictSummary", () => {
  it("names one field and lists two", () => {
    expect(conflictSummary([{ field: "title", base: "", local: "", remote: "" }])).toBe(
      "title differs",
    );
    expect(
      conflictSummary([
        { field: "title", base: "", local: "", remote: "" },
        { field: "status", base: "", local: "", remote: "" },
      ]),
    ).toBe("title and status differ");
  });
});

describe("taskSourceState", () => {
  it("reports off, failed and synced", () => {
    expect(taskSourceState({ ...SETTINGS, enabled: false }).label).toBe("Off");
    expect(taskSourceState({ ...SETTINGS, lastError: "Token rejected (401)" })).toEqual({
      label: "Failed",
      tone: "error",
    });
    expect(taskSourceState(SETTINGS).label).toBe("Synced");
  });
});

describe("slackConnectionState", () => {
  it("prefers the error over the connection", () => {
    expect(slackConnectionState(slackInfo({ error: "boom" })).label).toBe("Failed");
    expect(slackConnectionState(slackInfo({ connection: "retrying" })).label).toBe("Retrying");
    expect(slackConnectionState(slackInfo({ enabled: false })).label).toBe("Off");
  });
});

describe("slackRequestLabel", () => {
  it("shows the queue position while queued", () => {
    expect(slackRequestLabel(request({ state: "queued", queuePosition: 2 }))).toBe("Queued · 2");
    expect(slackRequestLabel(request({ state: "pending" }))).toBe("Awaiting approval");
  });
});

describe("settingsInputFrom", () => {
  it("copies stored values and applies a patch", () => {
    const input = settingsInputFrom(SETTINGS, { enabled: false });
    expect(input.enabled).toBe(false);
    expect(input.notionDataSourceId).toBe("data-source");
    expect(input.notionStatusMapping?.done).toBe("Done");
    expect(input.githubLabel).toBeNull();
  });
});

describe("status value parsing", () => {
  it("round-trips a comma separated list and empties blanks", () => {
    expect(parseStatusValues(" Todo, In progress ,,")).toEqual(["Todo", "In progress"]);
    expect(joinStatusValues(["Todo", "Done"])).toBe("Todo, Done");
    expect(blankToNull("   ")).toBeNull();
    expect(blankToNull(" value ")).toBe("value");
  });
});
