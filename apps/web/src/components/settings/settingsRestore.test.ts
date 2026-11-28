import { expect, it } from "vite-plus/test";

import { DEFAULT_UNIFIED_SETTINGS } from "@houston-app/contracts";
import { settingsRestoreDefaultsPatch } from "./SettingsPanels";

it("restores every usage-limit setting, including the account-wide hold", () => {
  const patch = settingsRestoreDefaultsPatch();
  expect(patch.holdUnlimitedThreads).toBe(DEFAULT_UNIFIED_SETTINGS.holdUnlimitedThreads);
  expect(patch.snoozeLimitedThreads).toBe(DEFAULT_UNIFIED_SETTINGS.snoozeLimitedThreads);
  expect(patch.autoResumeLimitedThreads).toBe(DEFAULT_UNIFIED_SETTINGS.autoResumeLimitedThreads);
  expect(patch.holdAgentMessagesAfterStop).toBe(
    DEFAULT_UNIFIED_SETTINGS.holdAgentMessagesAfterStop,
  );
  expect(patch.holdNewSubagentsUnderLoad).toBe(DEFAULT_UNIFIED_SETTINGS.holdNewSubagentsUnderLoad);
  expect(patch.concurrentRuns).toBe(DEFAULT_UNIFIED_SETTINGS.concurrentRuns);
  expect(patch.notifyWhenThreadWaits).toBe(DEFAULT_UNIFIED_SETTINGS.notifyWhenThreadWaits);
  expect(patch.showCommentButtonOnSelection).toBe(
    DEFAULT_UNIFIED_SETTINGS.showCommentButtonOnSelection,
  );
  expect(patch.snoozePresets).toEqual(DEFAULT_UNIFIED_SETTINGS.snoozePresets);
});
