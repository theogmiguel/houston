import type { ContextMenuItem } from "@houston-app/contracts";

import { buildBulkTitleRegenerationContextMenuItem } from "../components/Sidebar.logic";
import type { SnoozePreset } from "../components/Sidebar.snooze";

export type BulkMenuAction =
  | "close"
  | "hold:custom"
  | `hold:${string}`
  | "regenerate-title"
  | "mark-unread"
  | "delete";

export interface BulkMenuInput {
  readonly count: number;
  /** Selected threads that are not closed yet. */
  readonly closableCount: number;
  /** Whether every selected thread can be held right now. */
  readonly holdable: boolean;
  readonly presets: ReadonlyArray<Pick<SnoozePreset, "id" | "label" | "whenLabel">>;
  /** Selected threads whose title is not already being regenerated. */
  readonly regeneratableCount: number;
}

/** The right-click menu of a multi-selection: Close, Hold, Regenerate titles, Mark unread, Delete. */
export function buildBulkMenuItems(input: BulkMenuInput): ContextMenuItem<BulkMenuAction>[] {
  const regenerate = buildBulkTitleRegenerationContextMenuItem({
    supportedCount: input.count,
    actionableCount: input.regeneratableCount,
  });
  return [
    { id: "close", label: `Close (${input.count})`, disabled: input.closableCount === 0 },
    ...(input.holdable
      ? [
          {
            id: "hold:custom" as const,
            label: `Hold (${input.count})`,
            children: [
              ...input.presets.map((preset) => ({
                id: `hold:${preset.id}` as const,
                label: `${preset.label} (${preset.whenLabel})`,
              })),
              {
                id: "hold:custom" as const,
                label: "Custom…",
                separatorBefore: input.presets.length > 0,
              },
            ],
          },
        ]
      : []),
    ...(regenerate === null ? [] : [regenerate]),
    { id: "mark-unread", label: `Mark unread (${input.count})` },
    { id: "delete", label: `Delete (${input.count})`, destructive: true, separatorBefore: true },
  ];
}

/** The confirmation text for deleting a selection; names the count and what is lost. */
export function bulkDeleteConfirmation(count: number): string {
  return [
    `Delete ${count} thread${count === 1 ? "" : "s"}?`,
    "This permanently clears conversation history for these threads.",
  ].join("\n");
}
