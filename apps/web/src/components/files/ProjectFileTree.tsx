import type { ProjectEntry, VcsStatusResult } from "@houston-app/contracts";
import { ChevronDown, ChevronRight } from "lucide-react";
import { type DragEvent, type KeyboardEvent, type MouseEvent, useRef } from "react";

import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { Input } from "~/components/ui/input";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { useIsPhone } from "~/mobile/usePhone";

import {
  GIT_STATUS_LABEL,
  GIT_STATUS_LETTER,
  gitStatusColor,
  treeGitStatus,
} from "./fileTreeGitStatus";
import { type ProjectFileTreeRow } from "./projectFileTreeRows";

export interface FileTreeEditing {
  readonly mode: "rename" | "create";
  /** Rename source path, or the parent directory for a create at the root (`""`). */
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly initialValue: string;
  readonly depth: number;
}

interface ProjectFileTreeProps {
  readonly rows: ReadonlyArray<ProjectFileTreeRow>;
  readonly expandedPaths: ReadonlySet<string>;
  readonly selectedPath: string | null;
  readonly ariaLabel: string;
  readonly gitFiles?: VcsStatusResult["workingTree"]["files"];
  readonly editing?: FileTreeEditing | null;
  readonly editingError?: string | null;
  readonly onToggleDirectory: (path: string) => void;
  readonly onOpenFile: (path: string) => void;
  readonly onEntryContextMenu: (entry: ProjectEntry, event: MouseEvent<HTMLElement>) => void;
  readonly onEntryDragStart: (entry: ProjectEntry, event: DragEvent<HTMLElement>) => void;
  readonly onEntryDragEnd: () => void;
  readonly onStartRename?: ((entry: ProjectEntry) => void) | undefined;
  readonly onDeleteEntry?: ((entry: ProjectEntry) => void) | undefined;
  readonly onEditSubmit?: ((value: string) => void) | undefined;
  readonly onEditCancel?: (() => void) | undefined;
}

function focusRow(root: HTMLDivElement | null, direction: -1 | 1) {
  const rows = root?.querySelectorAll<HTMLElement>("[data-item-path]");
  if (!rows || rows.length === 0) return;
  const active = document.activeElement as HTMLElement | null;
  const current = active ? [...rows].indexOf(active) : -1;
  const next = Math.min(rows.length - 1, Math.max(0, current + direction));
  rows[next]?.focus();
}

function EditableRow({
  depth,
  initialValue,
  error,
  icon,
  onSubmit,
  onCancel,
}: {
  readonly depth: number;
  readonly initialValue: string;
  readonly error: string | null | undefined;
  readonly icon: React.ReactNode;
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
}) {
  return (
    <div
      data-file-tree-editor
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 28,
        marginLeft: 6,
        marginRight: 6,
        paddingLeft: 8 + depth * 14,
        paddingRight: 8,
      }}
    >
      <span style={{ width: 13, flexShrink: 0 }} aria-hidden />
      {icon}
      <div style={{ minWidth: 0, flex: 1 }}>
        <Input
          nativeInput
          autoFocus
          size="compact"
          type="text"
          aria-label={error ?? "Entry name"}
          defaultValue={initialValue}
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              const value = event.currentTarget.value.trim();
              if (value.length > 0) onSubmit(value);
              return;
            }
            if (event.key === "Escape") onCancel();
          }}
          onBlur={(event) => {
            const value = event.currentTarget.value.trim();
            if (value.length > 0) onSubmit(value);
            else onCancel();
          }}
        />
      </div>
    </div>
  );
}

export function ProjectFileTree({
  rows,
  expandedPaths,
  selectedPath,
  ariaLabel,
  gitFiles = [],
  editing = null,
  editingError = null,
  onToggleDirectory,
  onOpenFile,
  onEntryContextMenu,
  onEntryDragStart,
  onEntryDragEnd,
  onStartRename,
  onDeleteEntry,
  onEditSubmit,
  onEditCancel,
}: ProjectFileTreeProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The phone has no drag and drop: a row still opens on tap, but never starts a mention drag.
  const dragEnabled = !useIsPhone();
  const { resolvedTheme } = useTheme();
  const selectedVisible = rows.some((row) => row.entry.path === selectedPath);
  const firstFile = rows.find((row) => row.entry.kind === "file")?.entry.path ?? null;
  const submitEdit = onEditSubmit ?? (() => {});
  const cancelEdit = onEditCancel ?? (() => {});

  const activate = (entry: ProjectEntry) => {
    if (entry.kind === "directory") onToggleDirectory(entry.path);
    else onOpenFile(entry.path);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement | null)?.closest("[data-file-tree-editor]")) return;
    const target = event.target as HTMLElement | null;
    const path = target?.getAttribute("data-item-path");
    const row = rows.find((candidate) => candidate.entry.path === path);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusRow(rootRef.current, 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        focusRow(rootRef.current, -1);
        return;
      case "ArrowRight":
        if (row?.entry.kind === "directory" && !expandedPaths.has(row.entry.path)) {
          event.preventDefault();
          onToggleDirectory(row.entry.path);
        }
        return;
      case "ArrowLeft":
        if (row?.entry.kind === "directory" && expandedPaths.has(row.entry.path)) {
          event.preventDefault();
          onToggleDirectory(row.entry.path);
        }
        return;
      case "F2":
        if (row && onStartRename) {
          event.preventDefault();
          onStartRename(row.entry);
        }
        return;
      case "Delete":
        if (row && onDeleteEntry) {
          event.preventDefault();
          onDeleteEntry(row.entry);
        }
        return;
      case "Enter":
      case " ":
        if (row) {
          event.preventDefault();
          activate(row.entry);
        }
        return;
    }
  };

  const renderStatus = (entry: ProjectEntry) => {
    const status = treeGitStatus(entry.path, entry.kind === "directory", gitFiles);
    if (status === null) return null;
    return (
      <span
        aria-label={`Git status: ${GIT_STATUS_LABEL[status]}`}
        style={{
          width: 12,
          flexShrink: 0,
          textAlign: "center",
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
          fontSize: 11,
          color: gitStatusColor(status),
        }}
      >
        {GIT_STATUS_LETTER[status]}
      </span>
    );
  };

  const createEditorRow = editing?.mode === "create";
  const createParentIndex =
    createEditorRow && editing.path !== ""
      ? rows.findIndex((row) => row.entry.path === editing.path)
      : -1;
  const insertEditorAt = createEditorRow ? Math.max(0, createParentIndex + 1) : -1;

  return (
    <div
      ref={rootRef}
      role="tree"
      aria-label={ariaLabel}
      className="min-h-0 flex-1 overflow-y-auto pb-1.5"
      onKeyDown={handleKeyDown}
    >
      {createEditorRow && insertEditorAt === 0 ? (
        <EditableRow
          depth={editing.depth}
          initialValue={editing.initialValue}
          error={editingError}
          icon={
            <PierreEntryIcon
              pathValue="unnamed"
              kind={editing.kind === "directory" ? "directory" : "file"}
              theme={resolvedTheme}
              className="size-[13px]"
            />
          }
          onSubmit={submitEdit}
          onCancel={cancelEdit}
        />
      ) : null}
      {rows.map(({ entry, depth }, index) => {
        const directory = entry.kind === "directory";
        const isExpanded = directory && expandedPaths.has(entry.path);
        const selected = entry.path === selectedPath;
        const tabbable = selected || (!selectedVisible && entry.path === firstFile);
        const renaming = editing?.mode === "rename" && editing.path === entry.path;
        const createRow =
          createEditorRow && insertEditorAt === index + 1 ? (
            <EditableRow
              depth={editing.depth}
              initialValue={editing.initialValue}
              error={editingError}
              icon={
                <PierreEntryIcon
                  pathValue="unnamed"
                  kind={editing.kind === "directory" ? "directory" : "file"}
                  theme={resolvedTheme}
                  className="size-[13px]"
                />
              }
              onSubmit={submitEdit}
              onCancel={cancelEdit}
            />
          ) : null;
        return (
          <div key={entry.path}>
            {renaming ? (
              <EditableRow
                depth={depth}
                initialValue={editing.initialValue}
                error={editingError}
                icon={
                  <PierreEntryIcon
                    pathValue={entry.path}
                    kind={directory ? "directory" : "file"}
                    theme={resolvedTheme}
                    className="size-[13px]"
                  />
                }
                onSubmit={submitEdit}
                onCancel={cancelEdit}
              />
            ) : (
              <button
                type="button"
                role="treeitem"
                aria-selected={selected}
                aria-expanded={directory ? isExpanded : undefined}
                aria-level={depth + 1}
                data-item-path={entry.path}
                tabIndex={tabbable ? 0 : -1}
                draggable={dragEnabled}
                onClick={() => activate(entry)}
                onContextMenu={(event) => onEntryContextMenu(entry, event)}
                onDragStart={dragEnabled ? (event) => onEntryDragStart(entry, event) : undefined}
                onDragEnd={dragEnabled ? onEntryDragEnd : undefined}
                className={cn(
                  "mx-1.5 flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent pr-2 text-left text-xs outline-none",
                  "text-[var(--t1)] hover:bg-[var(--hover)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent-ink)]",
                  selected && "bg-[var(--sel)]",
                )}
                style={{ paddingLeft: 8 + depth * 14, opacity: entry.ignored ? 0.5 : undefined }}
              >
                <span className="flex w-[13px] shrink-0 items-center justify-center text-[var(--houston)]">
                  {directory ? (
                    isExpanded ? (
                      <ChevronDown className="size-[13px]" aria-hidden />
                    ) : (
                      <ChevronRight className="size-[13px]" aria-hidden />
                    )
                  ) : null}
                </span>
                <PierreEntryIcon
                  pathValue={entry.path}
                  kind={directory ? "directory" : "file"}
                  theme={resolvedTheme}
                  className="size-[13px]"
                />
                <span className="min-w-0 flex-1 truncate">
                  {entry.path.slice(entry.path.lastIndexOf("/") + 1)}
                </span>
                {renderStatus(entry)}
              </button>
            )}
            {createRow}
          </div>
        );
      })}
    </div>
  );
}
