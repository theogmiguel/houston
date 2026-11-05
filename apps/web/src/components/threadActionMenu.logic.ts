import type { ContextMenuItem } from "@houston-app/contracts";
import type { SnoozePreset } from "@houston-app/client-runtime/state/thread-settled";

export type ThreadActionMenuId =
  | "find"
  | "new-thread-on-branch"
  | "open-in-grid"
  | "move-to-grid"
  | `move-to-grid:${string}`
  | "settle"
  | "unsettle"
  | "auto-settle"
  | "auto-settle:enabled"
  | "auto-settle:disabled"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "filter-by-project"
  | "turn-into-project"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread"
  | "copy-thread-id"
  | "project-settings"
  | "archive"
  | "delete"
  | "split-right"
  | "split-down"
  | `split:${string}`
  | "swap"
  | `swap:${string}`;

export type DraftActionMenuId =
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "project-settings"
  | "discard";

export function buildDraftActionMenuItems(options: {
  readonly hasPath: boolean;
  readonly hasBranch: boolean;
  readonly hasProject: boolean;
}): ReadonlyArray<ContextMenuItem<DraftActionMenuId>> {
  return [
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      disabled: !options.hasPath && !options.hasBranch,
      children: [
        ...(options.hasPath ? [{ id: "copy-path" as const, label: "Path", icon: "folder" }] : []),
        ...(options.hasBranch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
      ],
    },
    ...(options.hasProject
      ? [{ id: "project-settings" as const, label: "Project settings", icon: "settings" }]
      : []),
    {
      id: "discard",
      label: "Discard draft",
      icon: "trash",
      destructive: true,
      separatorBefore: true,
    },
  ];
}

export interface ThreadActionMenuTarget {
  readonly gridId: string;
  readonly name: string;
}

export interface ThreadActionMenuSplitChoices {
  readonly availableThreads: ReadonlyArray<{ readonly threadId: string; readonly title: string }>;
  readonly atCap: boolean;
  readonly canCreateThread: boolean;
}

/** The grid surface a menu acts on; absent when the surface has no grid (the route header). */
export interface ThreadActionMenuGridState {
  readonly canOpenInGrid: boolean;
  readonly canMoveToGrid: boolean;
  readonly moveTargets: ReadonlyArray<ThreadActionMenuTarget>;
}

/** The layout actions only a grid cell offers. */
export interface ThreadActionMenuCellState {
  readonly split: ThreadActionMenuSplitChoices | null;
  readonly swapTargets: ReadonlyArray<{ readonly threadId: string; readonly title: string }>;
}

export interface ThreadActionMenuState {
  readonly canOperate: boolean;
  readonly canFind?: boolean;
  /** The surface owns thread creation, so it can start one on the thread's branch. */
  readonly canStartBranchThread?: boolean;
  /** No thread is behind the cell yet (a draft pane), so only layout actions apply. */
  readonly hasThread?: boolean;
  readonly branch: string | null;
  readonly projectFilter: {
    readonly label: string;
    readonly isActive: boolean;
  } | null;
  readonly isSettled: boolean;
  readonly autoSettleEnabled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects attached providers, so disable it while running. */
  readonly isRunning: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly autoSettleOptOut: boolean;
    readonly snooze: boolean;
    readonly titleRegeneration: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  /** A No project thread with its own folder, on a server that can promote it. */
  readonly canTurnIntoProject?: boolean;
  readonly grid?: ThreadActionMenuGridState | undefined;
  readonly cell?: ThreadActionMenuCellState | undefined;
}

/** Local navigation, read markers, copying and grid layout remain available to read-only clients. */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  if (
    action === "find" ||
    action === "new-thread-on-branch" ||
    action === "open-in-grid" ||
    action === "move-to-grid" ||
    action.startsWith("move-to-grid:") ||
    action === "project-settings" ||
    action === "mark-unread" ||
    action === "copy" ||
    action.startsWith("copy-") ||
    action === "swap" ||
    action.startsWith("swap:") ||
    action === "split-right" ||
    action === "split-down" ||
    action.startsWith("split:")
  ) {
    return false;
  }
  return true;
}

const SPLIT_SIDES = [
  { id: "split-right", side: "right", label: "Split right" },
  { id: "split-down", side: "bottom", label: "Split down" },
] as const;

function splitTargets(
  side: "right" | "bottom",
  split: ThreadActionMenuSplitChoices,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const prefix = side === "right" ? "split:right" : "split:bottom";
  const targets: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> =
    split.availableThreads.length > 0
      ? split.availableThreads.map((thread) => ({
          id: `${prefix}:${thread.threadId}` as const,
          label: thread.title,
        }))
      : [
          {
            id: `${prefix}:none` as const,
            label: split.atCap
              ? "This grid holds six threads"
              : "No other thread in this workspace",
            disabled: true,
          },
        ];
  return [
    ...targets,
    ...(split.canCreateThread
      ? [{ id: `${prefix}:new` as const, label: "New thread…", separatorBefore: true }]
      : []),
  ];
}

export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const hasThread = state.hasThread !== false;
  const items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> = [
    ...(state.cell !== undefined && state.cell.split !== null
      ? SPLIT_SIDES.map(({ id, side, label }) => ({
          id,
          label,
          children: splitTargets(side, state.cell!.split!),
        }))
      : []),
    ...(state.cell !== undefined && state.cell.swapTargets.length > 0
      ? [
          {
            id: "swap" as const,
            label: "Move to…",
            separatorBefore: state.cell.split !== null,
            children: state.cell.swapTargets.map((thread) => ({
              id: `swap:${thread.threadId}` as const,
              label: `Swap with ${thread.title}`,
            })),
          },
        ]
      : []),
    ...(hasThread && state.branch && state.canStartBranchThread === true
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: `New thread on ${state.branch}`,
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(hasThread && state.grid?.canOpenInGrid
      ? [{ id: "open-in-grid" as const, label: "Open in grid", icon: "layout-grid" }]
      : []),
    ...(hasThread && state.grid?.canMoveToGrid
      ? [
          {
            id: "move-to-grid" as const,
            label: "Move to grid",
            icon: "layout-grid",
            children: [
              ...state.grid.moveTargets.map((target) => ({
                id: `move-to-grid:${target.gridId}` as const,
                label: target.name,
              })),
              {
                id: "move-to-grid:new" as const,
                label: "New grid",
                separatorBefore: state.grid.moveTargets.length > 0,
              },
            ],
          },
        ]
      : []),
    ...(hasThread && state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: "Reopen thread", icon: "circle-check" }
            : { id: "settle" as const, label: "Close thread", icon: "circle-check" },
        ]
      : []),
    ...(hasThread && state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: "Bring thread back", icon: "clock" }
            : {
                id: "snooze" as const,
                label: "Hold",
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: `${preset.label} (${preset.whenLabel})`,
                  })),
                  {
                    id: "snooze:custom" as const,
                    label: "Custom…",
                    separatorBefore: state.snoozePresets.length > 0,
                  },
                ],
              },
        ]
      : []),
    ...(hasThread
      ? [{ id: "rename" as const, label: "Rename thread", icon: "pencil", separatorBefore: true }]
      : []),
    ...(hasThread && state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    ...(hasThread ? [{ id: "mark-unread" as const, label: "Mark unread", icon: "mail-open" }] : []),
    ...(hasThread && state.projectFilter
      ? [
          {
            id: "filter-by-project" as const,
            label: state.projectFilter.isActive
              ? "Show all projects"
              : `Filter by ${state.projectFilter.label}`,
            icon: "folder-tree",
          },
        ]
      : []),
    ...(hasThread && state.canTurnIntoProject
      ? [
          {
            id: "turn-into-project" as const,
            label: "Turn into project",
            icon: "folder-plus",
            disabled: state.isRunning,
          },
        ]
      : []),
    ...(hasThread && state.supports.autoSettleOptOut
      ? [
          {
            id: "auto-settle" as const,
            label: "Auto-close behavior",
            icon: "timer",
            children: [
              {
                id: "auto-settle:enabled" as const,
                label: "Enabled",
                checked: state.autoSettleEnabled,
              },
              {
                id: "auto-settle:disabled" as const,
                label: "Disabled",
                checked: !state.autoSettleEnabled,
              },
            ],
          },
        ]
      : []),
    ...(hasThread && state.canFind
      ? [{ id: "find" as const, label: "Find in thread", icon: "text-search" }]
      : []),
    ...(hasThread
      ? [
          {
            id: "copy" as const,
            label: "Copy",
            icon: "copy",
            separatorBefore: true,
            children: [
              { id: "copy-path" as const, label: "Path", icon: "folder" },
              ...(state.branch
                ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
                : []),
              { id: "copy-thread" as const, label: "Thread", icon: "message-square" },
              { id: "copy-thread-id" as const, label: "Thread ID", icon: "hash" },
            ],
          },
          { id: "project-settings" as const, label: "Project settings", icon: "settings" },
          {
            id: "archive" as const,
            label: "Archive thread",
            icon: "archive",
            disabled: state.isRunning,
            separatorBefore: true,
          },
          {
            id: "delete" as const,
            label: "Delete",
            destructive: true,
            icon: "trash",
          },
        ]
      : []),
  ];
  return state.canOperate
    ? items
    : items.map((item) =>
        threadActionRequiresOperate(item.id)
          ? {
              ...item,
              disabled: true,
              ...(item.children
                ? { children: item.children.map((child) => ({ ...child, disabled: true })) }
                : {}),
            }
          : item,
      );
}
