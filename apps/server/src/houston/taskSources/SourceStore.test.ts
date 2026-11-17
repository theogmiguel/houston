import { assert, describe, it } from "@effect/vitest";

import { settingsFromRow, type SettingsRow } from "./SourceStore.ts";

describe("stored task source settings", () => {
  it("reads a row written before the GitHub task source was removed", () => {
    const row: SettingsRow = {
      project_id: "project-1",
      provider: "notion",
      enabled: 1,
      revision: 4,
      settings_json: JSON.stringify({
        githubRepository: "acme/houston",
        githubLabel: "houston-ready",
        githubAssignedUser: null,
        notionDataSourceId: "0123456789abcdef0123456789abcdef",
        notionTitlePropertyId: "title",
        notionDescriptionPropertyId: null,
        notionStatusPropertyId: "status",
        notionAssigneePropertyId: "assignee",
        notionProjectRelationPropertyId: null,
        notionAssigneeUserId: "11111111-2222-3333-4444-555555555555",
        notionActiveStatusValues: ["Ready"],
        notionProjectsDataSourceId: null,
        notionProjectTitlePropertyId: null,
        notionProjectDescriptionPropertyId: null,
        notionPrUrlPropertyId: null,
        notionStatusMapping: {
          todo: "Ready",
          inProgress: null,
          inReview: null,
          done: null,
          canceled: null,
        },
      }),
    };
    const settings = settingsFromRow(row);
    assert.isTrue(settings.enabled);
    assert.strictEqual(settings.notionDataSourceId, "0123456789abcdef0123456789abcdef");
    assert.deepEqual(settings.notionActiveStatusValues, ["Ready"]);
    assert.deepEqual(settings.notionStatusMapping.todo, "Ready");
    assert.notProperty(settings, "githubRepository");
  });
});
