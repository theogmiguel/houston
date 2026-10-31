import type { ProjectEntry } from "@t3tools/contracts";
import { ChevronDown, ChevronRight, File as FileIcon, Folder } from "lucide-react";
import { type DragEvent, type KeyboardEvent, type MouseEvent, useRef } from "react";

import { cn } from "~/lib/utils";

import { type ProjectFileTreeRow } from "./projectFileTreeRows";

interface ProjectFileTreeProps {
  readonly rows: ReadonlyArray<ProjectFileTreeRow>;
  readonly expandedPaths: ReadonlySet<string>;
  readonly selectedPath: string | null;
  readonly ariaLabel: string;
  readonly onToggleDirectory: (path: string) => void;
  readonly onOpenFile: (path: string) => void;
  readonly onEntryContextMenu: (entry: ProjectEntry, event: MouseEvent<HTMLElement>) => void;
  readonly onEntryDragStart: (entry: ProjectEntry, event: DragEvent<HTMLElement>) => void;
  readonly onEntryDragEnd: () => void;
}

function focusRow(root: HTMLDivElement | null, direction: -1 | 1) {
  const rows = root?.querySelectorAll<HTMLElement>("[data-item-path]");
  if (!rows || rows.length === 0) return;
  const active = document.activeElement as HTMLElement | null;
  const current = active ? [...rows].indexOf(active) : -1;
  const next = Math.min(rows.length - 1, Math.max(0, current + direction));
  rows[next]?.focus();
}

export function ProjectFileTree({
  rows,
  expandedPaths,
  selectedPath,
  ariaLabel,
  onToggleDirectory,
  onOpenFile,
  onEntryContextMenu,
  onEntryDragStart,
  onEntryDragEnd,
}: ProjectFileTreeProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedVisible = rows.some((row) => row.entry.path === selectedPath);
  const firstFile = rows.find((row) => row.entry.kind === "file")?.entry.path ?? null;

  const activate = (entry: ProjectEntry) => {
    if (entry.kind === "directory") onToggleDirectory(entry.path);
    else onOpenFile(entry.path);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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
      case "Enter":
      case " ":
        if (row) {
          event.preventDefault();
          activate(row.entry);
        }
        return;
    }
  };

  return (
    <div
      ref={rootRef}
      role="tree"
      aria-label={ariaLabel}
      className="min-h-0 flex-1 overflow-y-auto pb-1.5"
      onKeyDown={handleKeyDown}
    >
      {rows.map(({ entry, depth }) => {
        const directory = entry.kind === "directory";
        const isExpanded = directory && expandedPaths.has(entry.path);
        const selected = entry.path === selectedPath;
        const tabbable = selected || (!selectedVisible && entry.path === firstFile);
        return (
          <button
            key={entry.path}
            type="button"
            role="treeitem"
            aria-selected={selected}
            aria-expanded={directory ? isExpanded : undefined}
            aria-level={depth + 1}
            data-item-path={entry.path}
            tabIndex={tabbable ? 0 : -1}
            draggable
            onClick={() => activate(entry)}
            onContextMenu={(event) => onEntryContextMenu(entry, event)}
            onDragStart={(event) => onEntryDragStart(entry, event)}
            onDragEnd={onEntryDragEnd}
            className={cn(
              "mx-1.5 flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent pr-2 text-left text-xs outline-none",
              "text-[var(--t1)] hover:bg-[var(--hover)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent-ink)]",
              selected && "bg-[var(--sel)]",
            )}
            style={{ paddingLeft: 8 + depth * 14 }}
          >
            <span className="flex w-[13px] shrink-0 items-center justify-center text-[var(--t3)]">
              {directory ? (
                isExpanded ? (
                  <ChevronDown className="size-[13px]" strokeWidth={1.7} aria-hidden />
                ) : (
                  <ChevronRight className="size-[13px]" strokeWidth={1.7} aria-hidden />
                )
              ) : null}
            </span>
            {directory ? (
              <Folder
                className="size-[13px] shrink-0 text-[var(--t2)]"
                strokeWidth={1.7}
                aria-hidden
              />
            ) : (
              <FileIcon
                className="size-[13px] shrink-0 text-[var(--t2)]"
                strokeWidth={1.7}
                aria-hidden
              />
            )}
            <span className="min-w-0 flex-1 truncate">{entry.path.slice(entry.path.lastIndexOf("/") + 1)}</span>
          </button>
        );
      })}
    </div>
  );
}
