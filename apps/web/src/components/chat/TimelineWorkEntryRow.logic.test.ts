import { describe, expect, it } from "vite-plus/test";

import { workEntryToolParts } from "./TimelineWorkEntryRow.logic";
import type { TimelineWorkEntry } from "./timelineRowContext";

const commandEntry = (status: "inProgress" | "completed") =>
  ({
    id: "command",
    createdAt: "2026-03-17T19:12:28.000Z",
    label: "Ran command",
    command: "pnpm test",
    rawCommand: "pnpm test",
    tone: "tool",
    itemType: "command_execution",
    toolLifecycleStatus: status,
  }) as unknown as TimelineWorkEntry;

describe("workEntryToolParts", () => {
  it.each<{ status: "inProgress" | "completed"; action: string }>([
    { status: "inProgress", action: "Running" },
    { status: "completed", action: "Ran" },
  ])("labels a $status command with the verb $action", ({ status, action }) => {
    expect(workEntryToolParts(commandEntry(status), undefined)).toMatchObject({
      action,
      value: "pnpm test",
    });
  });
});
