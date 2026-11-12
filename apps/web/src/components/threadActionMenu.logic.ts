import type { ContextMenuItem } from "@houston-app/contracts";
import type { SnoozePreset } from "@houston-app/client-runtime/state/thread-settled";

export type ThreadActionMenuId =
  | "find"
  | "new-thread-on-branch"
  | "move-to-workspace"
  | `move-to-workspace:${string}`
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
  | "tags"
  | "tag-edit"
  | `tag-toggle:${string}`
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
  | "more"
  | `section:${string}`;

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

/** The workspaces a thread's chat can move to; absent when the surface lists no workspaces. */
export interface ThreadActionMenuWorkspaceState {
  readonly targets: ReadonlyArray<{ readonly workspaceId: string; readonly name: string }>;
}

export interface ThreadActionMenuState {
  readonly canOperate: boolean;
  readonly canFind?: boolean;
  /** The surface owns thread creation, so it can start one on the thread's branch. */
  readonly canStartBranchThread?: boolean;
  /** False when no thread is behind the surface yet (a draft), so thread actions are left out. */
  readonly hasThread?: boolean;
  readonly branch: string | null;
  readonly projectFilter: {
    readonly label: string;
    readonly isActive: boolean;
  } | null;
  readonly isSettled: boolean;
  readonly autoSettleEnabled: boolean;
  /** The tags on the thread, and others in the workspace offered as toggles. */
  readonly tags: ReadonlyArray<string>;
  readonly tagSuggestions: ReadonlyArray<string>;
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
  readonly workspace?: ThreadActionMenuWorkspaceState | undefined;
}

/** Local navigation, read markers, copying and workspace moves remain available to read-only clients. */
export function threadActionRequiresOperate(action: ThreadActionMenuId): boolean {
  if (
    action === "find" ||
    action === "new-thread-on-branch" ||
    action === "move-to-workspace" ||
    action.startsWith("move-to-workspace:") ||
    action === "project-settings" ||
    action === "mark-unread" ||
    action === "copy" ||
    action.startsWith("copy-") ||
    action === "more" ||
    action.startsWith("section:")
  ) {
    return false;
  }
  return true;
}

type ThreadActionMenuItem = ContextMenuItem<ThreadActionMenuId>;

/** A labelled group; an empty group emits nothing, so no header or separator is left dangling. */
function menuSection(
  id: string,
  label: string | null,
  entries: ReadonlyArray<ThreadActionMenuItem | null>,
): ReadonlyArray<ThreadActionMenuItem> {
  const present = entries.filter((entry): entry is ThreadActionMenuItem => entry !== null);
  if (present.length === 0) return [];
  return [
    ...(label === null
      ? []
      : [
          {
            id: `section:${id}` as const,
            label,
            header: true,
            separatorBefore: true,
          },
        ]),
    ...present,
  ];
}

export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const hasThread = state.hasThread !== false;
  const thread = hasThread
    ? menuSection("thread", "Thread", [
        { id: "rename", label: "Rename thread", icon: "pencil" },
        { id: "mark-unread", label: "Mark unread", icon: "mail-open" },
        state.canFind ? { id: "find", label: "Find in thread", icon: "text-search" } : null,
        {
          id: "copy",
          label: "Copy",
          icon: "copy",
          children: [
            { id: "copy-path", label: "Path", icon: "folder" },
            ...(state.branch
              ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
              : []),
            { id: "copy-thread", label: "Thread", icon: "message-square" },
            { id: "copy-thread-id", label: "Thread ID", icon: "hash" },
          ],
        },
      ])
    : [];
  const status = hasThread
    ? menuSection("status", "Status", [
        state.supports.settlement
          ? state.isSettled
            ? { id: "unsettle", label: "Reopen thread", icon: "circle-check" }
            : { id: "settle", label: "Close thread", icon: "circle-check" }
          : null,
        state.supports.snooze
          ? state.isSnoozed
            ? { id: "unsnooze", label: "Bring thread back", icon: "clock" }
            : {
                id: "snooze",
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
              }
          : null,
      ])
    : [];
  const organise = hasThread
    ? menuSection("organise", "Organise", [
        state.workspace !== undefined && state.workspace.targets.length > 0
          ? {
              id: "move-to-workspace",
              label: "Move to workspace",
              icon: "layout-grid",
              children: state.workspace.targets.map((target) => ({
                id: `move-to-workspace:${target.workspaceId}` as const,
                label: target.name,
              })),
            }
          : null,
        {
          id: "tags",
          label: "Tags",
          icon: "tag",
          children: [
            ...state.tagSuggestions.map((tag) => ({
              id: `tag-toggle:${tag}` as const,
              label: tag,
              checked: state.tags.includes(tag),
            })),
            {
              id: "tag-edit" as const,
              label: "Edit tags…",
              separatorBefore: state.tagSuggestions.length > 0,
            },
          ],
        },
        state.projectFilter
          ? {
              id: "filter-by-project",
              label: state.projectFilter.isActive
                ? "Show all projects"
                : `Filter by ${state.projectFilter.label}`,
              icon: "folder-tree",
            }
          : null,
        state.branch && state.canStartBranchThread === true
          ? {
              id: "new-thread-on-branch",
              label: `New thread on ${state.branch}`,
              icon: "message-square-plus",
            }
          : null,
        { id: "project-settings", label: "Project settings", icon: "settings" },
        state.canTurnIntoProject
          ? {
              id: "turn-into-project",
              label: "Turn into project",
              icon: "folder-plus",
              disabled: state.isRunning,
            }
          : null,
      ])
    : [];
  const more = hasThread
    ? menuSection("more", null, [
        state.supports.titleRegeneration || state.supports.autoSettleOptOut
          ? {
              id: "more",
              label: "More",
              separatorBefore: true,
              children: [
                ...(state.supports.titleRegeneration
                  ? [
                      {
                        id: "regenerate-title" as const,
                        label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
                        icon: "refresh-cw",
                        disabled: state.isRegeneratingTitle,
                      },
                    ]
                  : []),
                ...(state.supports.autoSettleOptOut
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
              ],
            }
          : null,
      ])
    : [];
  const danger = hasThread
    ? [
        {
          id: "archive" as const,
          label: "Archive thread",
          icon: "archive",
          disabled: state.isRunning,
          separatorBefore: true,
        },
        { id: "delete" as const, label: "Delete", destructive: true, icon: "trash" },
      ]
    : [];
  const items: ReadonlyArray<ThreadActionMenuItem> = [
    ...thread,
    ...status,
    ...organise,
    ...more,
    ...danger,
  ].map((item, index) => (index === 0 ? { ...item, separatorBefore: false } : item));
  return state.canOperate ? items : items.map(disableOperateActions);
}

function disableOperateActions(item: ThreadActionMenuItem): ThreadActionMenuItem {
  if (threadActionRequiresOperate(item.id)) {
    return {
      ...item,
      disabled: true,
      ...(item.children ? { children: item.children.map(disableAll) } : {}),
    };
  }
  return item.children ? { ...item, children: item.children.map(disableOperateActions) } : item;
}

function disableAll(item: ThreadActionMenuItem): ThreadActionMenuItem {
  return {
    ...item,
    disabled: true,
    ...(item.children ? { children: item.children.map(disableAll) } : {}),
  };
}
