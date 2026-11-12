/**
 * The workspace switcher: a trigger that names the focused workspace and where it sits in the
 * stack, and a list to go to, create, rename, reorder and delete workspaces. Reads the layout
 * store and calls the workspace actions; the caller supplies the title of an unnamed workspace.
 */
import {
  ArrowDownIcon,
  ArrowUpIcon,
  LayersIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  LayoutErrorText,
  LayoutListRow,
  LayoutListRowActions,
  LayoutListRowButton,
  LayoutListRowCheck,
  LayoutMetaText,
  LayoutPopoverFooter,
} from "../components/ui/layout-overlay";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/utils";
import type { LayoutWorkspace } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import {
  createLayoutWorkspaceAction,
  deleteLayoutWorkspaceAction,
  moveLayoutWorkspaceAction,
  renameLayoutWorkspaceAction,
} from "./layoutWorkspaceActions";
import { listLayoutWorkspaces, WORKSPACE_NAME_MAX_CHARS } from "./layoutWorkspaces";

export interface WorkspaceSwitcherProps {
  /** The title of a workspace without a name of its own, such as its lead tab's title. */
  readonly resolveWorkspaceTitle?: (workspace: LayoutWorkspace) => string | null;
  readonly className?: string;
}

/** What a workspace is called where it is listed. */
export function workspaceDisplayName(
  workspace: LayoutWorkspace,
  position: number,
  resolveTitle?: (workspace: LayoutWorkspace) => string | null,
): string {
  const named = workspace.name?.trim();
  if (named) return named;
  const title = resolveTitle?.(workspace)?.trim();
  if (title) return title;
  return workspace.columns.length === 0 ? "Empty workspace" : `Workspace ${position + 1}`;
}

function paneCount(workspace: LayoutWorkspace): number {
  return workspace.columns.reduce((sum, column) => sum + column.panes.length, 0);
}

function paneSummary(workspace: LayoutWorkspace): string {
  const panes = paneCount(workspace);
  if (panes === 0) return "Empty";
  return panes === 1 ? "1 pane" : `${panes} panes`;
}

type Editing = { kind: "rename"; workspaceId: string } | { kind: "create" };

export function WorkspaceSwitcher({ resolveWorkspaceTitle, className }: WorkspaceSwitcherProps) {
  const layout = useLayoutStore((state) => state.layout);
  const focusWorkspace = useLayoutStore((state) => state.focusWorkspace);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const workspaces = listLayoutWorkspaces(layout);
  const focusedIndex = Math.max(
    0,
    workspaces.findIndex((workspace) => workspace.id === layout.focusedWorkspaceId),
  );
  const focused = workspaces[focusedIndex];
  const nameOf = (workspace: LayoutWorkspace) =>
    workspaceDisplayName(workspace, layout.workspaces.indexOf(workspace), resolveWorkspaceTitle);

  const reset = () => {
    setEditing(null);
    setConfirming(null);
    setMessage(null);
  };

  const commitEdit = () => {
    if (!editing) return;
    const refusal =
      editing.kind === "create"
        ? createLayoutWorkspaceAction(draft)
        : renameLayoutWorkspaceAction(editing.workspaceId, draft);
    if (refusal) {
      setMessage(refusal);
      return;
    }
    reset();
    if (editing.kind === "create") setOpen(false);
  };

  const onEditKey = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitEdit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      reset();
    }
  };

  const startEdit = (next: Editing, initial: string) => {
    setConfirming(null);
    setMessage(null);
    setDraft(initial);
    setEditing(next);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost-muted"
            size="xs"
            aria-label="Workspaces"
            data-layout-workspace-switcher=""
            className={cn("max-w-full min-w-0", className)}
          />
        }
      >
        <LayersIcon aria-hidden />
        <span className="min-w-0 truncate max-sm:sr-only">
          {focused ? nameOf(focused) : "Workspace"}
        </span>
        {workspaces.length > 1 ? (
          <LayoutMetaText tabular className="shrink-0">
            {focusedIndex + 1} of {workspaces.length}
          </LayoutMetaText>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-72" aria-label="Workspaces list">
        <div className="flex w-full flex-col gap-1 py-1">
          <ul className="flex flex-col" aria-label="Workspaces">
            {workspaces.map((workspace, index) => {
              const isFocused = workspace.id === layout.focusedWorkspaceId;
              const renaming = editing?.kind === "rename" && editing.workspaceId === workspace.id;
              const name = nameOf(workspace);
              return (
                <LayoutListRow key={workspace.id} data-workspace-id={workspace.id}>
                  {renaming ? (
                    <Input
                      autoFocus
                      size="compact"
                      aria-label={`Rename ${name}`}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={onEditKey}
                    />
                  ) : (
                    <LayoutListRowButton
                      aria-label={`Go to ${name}`}
                      aria-current={isFocused ? "true" : undefined}
                      onClick={() => {
                        focusWorkspace(workspace.id);
                        setOpen(false);
                      }}
                    >
                      <LayoutListRowCheck shown={isFocused} />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <LayoutMetaText className="shrink-0">{paneSummary(workspace)}</LayoutMetaText>
                    </LayoutListRowButton>
                  )}
                  {confirming === workspace.id ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <Button
                        size="xs"
                        variant="destructive"
                        onClick={() => {
                          const refusal = deleteLayoutWorkspaceAction(workspace.id);
                          if (refusal) setMessage(refusal);
                          else reset();
                        }}
                      >
                        Delete
                      </Button>
                      <Button size="xs" variant="ghost-muted" onClick={() => setConfirming(null)}>
                        Cancel
                      </Button>
                    </span>
                  ) : renaming ? null : (
                    <LayoutListRowActions>
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={`Rename ${name}`}
                        onClick={() =>
                          startEdit(
                            { kind: "rename", workspaceId: workspace.id },
                            workspace.name ?? "",
                          )
                        }
                      >
                        <PencilIcon aria-hidden />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={`Move ${name} up`}
                        disabled={index === 0 || workspace.columns.length === 0}
                        onClick={() => moveLayoutWorkspaceAction(workspace.id, -1)}
                      >
                        <ArrowUpIcon aria-hidden />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={`Move ${name} down`}
                        disabled={index === workspaces.length - 1 || workspace.columns.length === 0}
                        onClick={() => moveLayoutWorkspaceAction(workspace.id, 1)}
                      >
                        <ArrowDownIcon aria-hidden />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost-destructive"
                        aria-label={`Delete ${name}`}
                        onClick={() => {
                          setMessage(null);
                          // The last workspace is refused at once, with its reason, not after a confirmation.
                          if (workspaces.length <= 1) {
                            const refusal = deleteLayoutWorkspaceAction(workspace.id);
                            if (refusal) setMessage(refusal);
                          } else setConfirming(workspace.id);
                        }}
                      >
                        <Trash2Icon aria-hidden />
                      </Button>
                    </LayoutListRowActions>
                  )}
                </LayoutListRow>
              );
            })}
          </ul>
          {message ? <LayoutErrorText>{message}</LayoutErrorText> : null}
          <LayoutPopoverFooter>
            {editing?.kind === "create" ? (
              <div className="flex items-center gap-1 px-1">
                <Input
                  autoFocus
                  size="compact"
                  aria-label="New workspace name"
                  placeholder={`Name, up to ${WORKSPACE_NAME_MAX_CHARS} characters`}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onEditKey}
                />
                <Button size="xs" onClick={commitEdit}>
                  Create
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost-muted"
                size="xs"
                className="w-full justify-start"
                onClick={() => startEdit({ kind: "create" }, "")}
              >
                <PlusIcon aria-hidden />
                New workspace
              </Button>
            )}
          </LayoutPopoverFooter>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
