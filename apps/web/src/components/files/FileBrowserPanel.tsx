import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  type EnvironmentId,
  type ProjectEntry,
  ProjectFileMutationError,
} from "@houston-app/contracts";
import * as Schema from "effect/Schema";
import { settlePromise, squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import { serializeComposerFileLink } from "@houston-app/shared/composerTrigger";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { ChevronsDownUp, ChevronsUpDown } from "lucide";
import { Search } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { Button } from "~/components/ui/button";
import { requestConfirmDialog } from "~/confirmDialog";
import { Kbd } from "~/components/ui/kbd";
import { MorphIcon } from "~/components/MorphIcon";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { useFileContextMenu, type FileContextMenuAction } from "~/fileContextMenu";
import { readLocalApi } from "~/localApi";
import { projectEnvironment } from "~/state/projects";
import { vcsEnvironment } from "~/state/vcs";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";

import { joinHostPath } from "./filePath";
import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import { loadFileAncestors } from "./loadFileAncestors";
import { type FileTreeEditing, ProjectFileTree } from "./ProjectFileTree";
import {
  ancestorDirectoryPaths,
  expandableDirectoryPaths,
  projectFileTreeRows,
} from "./projectFileTreeRows";
import { useDirectoryEntries } from "./useDirectoryEntries";
import { useProjectPathSearch } from "~/state/queries";

const VALID_NAME_PATTERN = /[\u0000-\u001f\u007f]/;

const isProjectFileMutationError = Schema.is(ProjectFileMutationError);

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  selectedPath: string | null;
  selectedPathRevealId: number;
  onOpenFile: (relativePath: string) => void;
  /** Host-folder entries use absolute paths. Avoid full traversal: disable expand-all and search only
   * loaded folders. */
  hostFolder?: boolean;
  onRefreshSelectedFile?: () => void;
  workspaceMutationId: string | null;
}

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh workspace files"
            onClick={props.onRefresh}
          />
        }
      >
        <RefreshIcon refreshing={props.isPending} />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
    </Tooltip>
  );
}

function buildTreeEntries(
  directoryEntries: readonly ProjectEntry[],
  searchEntries: readonly ProjectEntry[],
  searchPending: boolean,
  query: string,
): readonly ProjectEntry[] {
  const result = new Map(directoryEntries.map((entry) => [entry.path, entry]));
  if (query.trim() && !searchPending) {
    for (const entry of searchEntries) {
      if (!result.has(entry.path)) result.set(entry.path, entry);
      const segments = entry.path.split("/");
      for (let index = 1; index < segments.length; index++) {
        const path = segments.slice(0, index).join("/");
        if (!result.has(path)) result.set(path, { path, kind: "directory" });
      }
    }
  }
  return [...result.values()];
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath,
  selectedPathRevealId,
  onOpenFile,
  onRefreshSelectedFile,
  workspaceMutationId,
  hostFolder = false,
}: FileBrowserPanelProps) {
  const panelPath = (relativePath: string) =>
    hostFolder ? joinHostPath(cwd, relativePath) : relativePath;
  const composerRef = useComposerHandleContext();
  const fileContextMenu = useFileContextMenu(environmentId);
  const {
    entries: directoryEntries,
    load,
    refresh,
    ready,
    error,
    isPending,
  } = useDirectoryEntries(environmentId, cwd);
  const [query, setQuery] = useState("");
  const [expandAll, setExpandAll] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [editing, setEditing] = useState<FileTreeEditing | null>(null);
  const [editingError, setEditingError] = useState<string | null>(null);
  const createEntry = useAtomCommand(projectEnvironment.createEntry, { reportFailure: false });
  const renameEntry = useAtomCommand(projectEnvironment.renameEntry, { reportFailure: false });
  const deleteEntry = useAtomCommand(projectEnvironment.deleteEntry, { reportFailure: false });
  const gitStatus = useEnvironmentQuery(
    hostFolder ? null : vcsEnvironment.status({ environmentId, input: { cwd } }),
  );
  const gitFiles = gitStatus.data?.workingTree.files ?? [];
  const pathSearch = useProjectPathSearch(
    { environmentId, cwd: hostFolder ? null : cwd, query: query.slice(0, 256) },
    200,
  );
  const entries = buildTreeEntries(
    directoryEntries,
    pathSearch.entries,
    pathSearch.isPending,
    query,
  );
  const directoryPaths = expandableDirectoryPaths(entries);
  const rows = projectFileTreeRows(entries, expandedPaths, query);
  const allDirectoriesExpanded =
    directoryPaths.length > 0 && directoryPaths.every((path) => expandedPaths.has(path));

  const submittingRef = useRef(false);
  const parentPathOf = (path: string) => {
    const slash = path.lastIndexOf("/");
    return slash < 0 ? "" : path.slice(0, slash);
  };
  const depthOfDirectory = (path: string) =>
    path === "" ? 0 : (rows.find((row) => row.entry.path === path)?.depth ?? -1) + 1;

  const startCreate = (entry: ProjectEntry | null, kind: "file" | "directory") => {
    const parentPath =
      entry === null ? "" : entry.kind === "directory" ? entry.path : parentPathOf(entry.path);
    if (parentPath !== "" && !expandedPaths.has(parentPath)) {
      setExpandAll(false);
      setExpandedPaths((current) => new Set(current).add(parentPath));
      void load(parentPath);
    }
    setEditingError(null);
    setEditing({
      mode: "create",
      path: parentPath,
      kind,
      initialValue: "",
      depth: depthOfDirectory(parentPath),
    });
  };

  const startRename = (entry: ProjectEntry) => {
    setEditingError(null);
    setEditing({
      mode: "rename",
      path: entry.path,
      kind: entry.kind,
      initialValue: entry.path.slice(entry.path.lastIndexOf("/") + 1),
      depth: rows.find((row) => row.entry.path === entry.path)?.depth ?? 0,
    });
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditingError(null);
  };

  const validName = (name: string) =>
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !VALID_NAME_PATTERN.test(name);

  const submitEdit = async (value: string) => {
    if (!editing || submittingRef.current) return;
    if (!validName(value)) {
      setEditingError("Use a name without slashes or control characters.");
      return;
    }
    const applyEdit = async (edit: NonNullable<typeof editing>) => {
      if (edit.mode === "create") {
        const relativePath = edit.path === "" ? value : `${edit.path}/${value}`;
        const result = await createEntry({
          environmentId,
          input: { cwd, relativePath, kind: edit.kind },
        });
        if (result._tag === "Failure") {
          const cause = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: `Could not create ${edit.kind === "directory" ? "folder" : "file"}`,
            description: cause instanceof Error ? cause.message : undefined,
          });
          return;
        }
        cancelEdit();
        void load(edit.path, true);
        if (edit.kind === "file") onOpenFile(panelPath(relativePath));
        return;
      }
      const toPath = parentPathOf(edit.path) === "" ? value : `${parentPathOf(edit.path)}/${value}`;
      if (toPath === edit.path) {
        cancelEdit();
        return;
      }
      const result = await renameEntry({
        environmentId,
        input: { cwd, fromPath: edit.path, toPath },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not rename entry",
          description: cause instanceof Error ? cause.message : undefined,
        });
        return;
      }
      cancelEdit();
      void load(parentPathOf(edit.path), true);
    };
    submittingRef.current = true;
    try {
      await applyEdit(editing);
    } catch (error) {
      submittingRef.current = false;
      throw error;
    }
    submittingRef.current = false;
  };

  const requestDelete = async (entry: ProjectEntry) => {
    const confirmation = requestConfirmDialog(`Move "${entry.path}" to the Trash?`);
    if (!confirmation || !(await confirmation)) return;
    const result = await deleteEntry({
      environmentId,
      input: { cwd, relativePath: entry.path },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      if (isProjectFileMutationError(cause) && cause.failure === "trash_unavailable") {
        const permanent = requestConfirmDialog(
          `${cause.message} Delete "${entry.path}" permanently instead? This cannot be undone.`,
          { variant: "destructive" },
        );
        if (!permanent || !(await permanent)) return;
        const permanentResult = await deleteEntry({
          environmentId,
          input: { cwd, relativePath: entry.path, permanent: true },
        });
        if (permanentResult._tag === "Failure") {
          const permanentCause = squashAtomCommandFailure(permanentResult);
          toastManager.add({
            type: "error",
            title: "Could not delete entry",
            description: permanentCause instanceof Error ? permanentCause.message : undefined,
          });
          return;
        }
        void load(parentPathOf(entry.path), true);
        return;
      }
      toastManager.add({
        type: "error",
        title: "Could not delete entry",
        description: cause instanceof Error ? cause.message : undefined,
      });
      return;
    }
    void load(parentPathOf(entry.path), true);
  };

  const showEntryContextMenu = useStableCallback(
    (entry: ProjectEntry, event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      const api = readLocalApi();
      if (!api) return;
      const relativePath = entry.path;
      const mention = serializeComposerFileLink(panelPath(relativePath));
      const position = { x: event.clientX, y: event.clientY };
      const fileTarget = { environmentId, filePath: relativePath, workspaceRoot: cwd };
      const fileMenuItems = fileContextMenu.buildItems(fileTarget);
      void settlePromise(async () => {
        const clicked = await api.contextMenu.show(
          [
            ...(hostFolder
              ? []
              : [
                  { id: "new-file", label: "New file" },
                  { id: "new-folder", label: "New folder" },
                  { id: "rename", label: "Rename" },
                  {
                    id: "delete",
                    label: "Delete",
                    destructive: true,
                    separatorBefore: true,
                  },
                ]),
            ...fileMenuItems,
            { id: "copy-mention", label: "Copy mention", separatorBefore: true },
            { id: "add-to-chat", label: "Add to chat" },
          ],
          position,
        );
        if (clicked === null) return;
        if (clicked === "new-file") {
          startCreate(entry, "file");
          return;
        }
        if (clicked === "new-folder") {
          startCreate(entry, "directory");
          return;
        }
        if (clicked === "rename") {
          startRename(entry);
          return;
        }
        if (clicked === "delete") {
          await requestDelete(entry);
          return;
        }
        const isFileMenuAction =
          fileMenuItems.some((item) => item.id === clicked) || clicked.startsWith("editor:");
        if (isFileMenuAction) {
          await fileContextMenu.activate(clicked as FileContextMenuAction, fileTarget);
          return;
        }
        if (clicked === "copy-mention") {
          try {
            await writeTextToClipboard(mention);
            toastManager.add({
              type: "success",
              title: "Mention copied",
              description: relativePath,
            });
          } catch (copyError) {
            toastManager.add({
              type: "error",
              title: "Failed to copy mention",
              description: copyError instanceof Error ? copyError.message : "An error occurred.",
            });
          }
          return;
        }
        if (clicked === "add-to-chat") {
          const composer = composerRef?.current;
          if (!composer) {
            toastManager.add({
              type: "error",
              title: "Unable to add to chat",
              description: "Open a chat for this project and try again.",
            });
            return;
          }
          const inserted = composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true });
          if (!inserted) {
            toastManager.add({
              type: "error",
              title: "Unable to add to chat",
              description: "The chat isn't ready to accept input right now.",
            });
          }
        }
      }).then((result) => {
        if (!AsyncResult.isSuccess(result)) throw Cause.squash(result.cause);
      });
    },
  );

  const dragMention = createFileTreeDragMentionController(
    hostFolder ? { mentionPath: (path: string) => joinHostPath(cwd, path) } : {},
  );

  const toggleDirectory = (path: string) => {
    setExpandAll(false);
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    void load(path);
  };

  const toggleAllDirectories = () => {
    const expanded = !(expandAll || allDirectoriesExpanded);
    setExpandAll(expanded);
    if (expanded) {
      setExpandedPaths(new Set(directoryPaths));
      for (const path of directoryPaths) void load(path);
    } else {
      setExpandedPaths(new Set());
    }
  };

  // Keep expand-all on as newly read folders arrive.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- adds newly loaded directories to the expansion set while expand-all is on
  useEffect(() => {
    if (!expandAll) return;
    setExpandedPaths((current) => {
      const missing = directoryPaths.filter((path) => !current.has(path));
      if (missing.length === 0) return current;
      return new Set([...current, ...missing]);
    });
  }, [directoryPaths, expandAll]);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- loads the selected file's ancestor directories and aborts on cleanup
  useEffect(() => {
    if (!selectedPath) return;
    const controller = new AbortController();
    void loadFileAncestors(selectedPath, load, { signal: controller.signal });
    return () => {
      controller.abort();
    };
  }, [load, selectedPath]);

  // Reveal a selection made outside the tree by opening its ancestors.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- expands the ancestors of an externally selected path
  useEffect(() => {
    if (!selectedPath) return;
    const ancestors = ancestorDirectoryPaths(selectedPath);
    if (ancestors.length === 0) return;
    setExpandedPaths((current) => {
      const missing = ancestors.filter((path) => !current.has(path));
      if (missing.length === 0) return current;
      return new Set([...current, ...missing]);
    });
  }, [selectedPath]);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- scrolls the selected row into view after the tree re-renders
  useEffect(() => {
    if (!selectedPath) return;
    const row = document.querySelector<HTMLElement>(
      `[data-file-browser-panel] [data-item-path="${CSS.escape(selectedPath)}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [rows, selectedPath, selectedPathRevealId]);

  const handleSearchValueChange = (value: string) => setQuery(value);
  const closeSearch = () => setQuery("");
  const handleRefresh = () => {
    refresh();
    if (query.trim()) pathSearch.refresh();
    onRefreshSelectedFile?.();
  };
  useWorkspaceMutationRefresh({
    mutationId: workspaceMutationId,
    refresh: () => {
      refresh();
      if (query.trim()) pathSearch.refresh();
    },
    resourceKey: `files:${environmentId}:${cwd}`,
  });

  const hasNoSearchMatches = ready && query.trim().length > 0 && rows.length === 0;
  const loading = !ready || pathSearch.isPending;

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
      onDragEnd={() => dragMention.handleDragEnd(() => {})}
    >
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1.5 pt-2" data-surface-subheader>
        <div className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md bg-[var(--field)] px-2 text-[var(--houston)]">
          <Search className="size-[13px] shrink-0" aria-hidden />
          <input
            type="search"
            name="project-files-search"
            value={query}
            aria-label={`Search ${projectName} files`}
            placeholder="Filter files"
            data-workspace-focus-default
            spellCheck={false}
            onChange={(event) => handleSearchValueChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              closeSearch();
              event.currentTarget.blur();
            }}
            className="min-w-0 flex-1 bg-transparent text-xs text-[var(--t1)] outline-none placeholder:text-[var(--houston)] [&::-webkit-search-cancel-button]:hidden"
          />
          {query.trim() ? null : <Kbd className="shrink-0">Ctrl P</Kbd>}
        </div>
        <RefreshFilesButton isPending={isPending} onRefresh={handleRefresh} />
        {directoryPaths.length > 0 && !hostFolder ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={
                    expandAll || allDirectoriesExpanded
                      ? "Collapse all folders"
                      : "Expand all folders"
                  }
                  onClick={toggleAllDirectories}
                />
              }
            >
              <MorphIcon
                className="size-3.5"
                icon={allDirectoriesExpanded ? ChevronsDownUp : ChevronsUpDown}
              />
            </TooltipTrigger>
            <TooltipPopup>
              {expandAll || allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {error || pathSearch.error ? (
        <button
          type="button"
          onClick={handleRefresh}
          className="px-3 py-2 text-left text-xs leading-relaxed text-destructive"
        >
          {error ?? pathSearch.error} Click to retry.
        </button>
      ) : null}
      {query.trim() && pathSearch.truncated && !pathSearch.isPending ? (
        <div className="px-3 py-1 text-xs text-muted-foreground">
          More matches available. Refine your search.
        </div>
      ) : null}
      {loading && !hasNoSearchMatches ? (
        <div role="status" className="px-3 py-1 text-xs text-muted-foreground">
          Loading files…
        </div>
      ) : null}
      {hasNoSearchMatches ? (
        <div role="status" className="px-3 py-4 text-xs text-muted-foreground">
          No matching files.
        </div>
      ) : (
        <ProjectFileTree
          rows={rows}
          expandedPaths={expandedPaths}
          selectedPath={selectedPath}
          ariaLabel={`${projectName} files`}
          gitFiles={gitFiles}
          editing={editing}
          editingError={editingError}
          onStartRename={hostFolder ? undefined : startRename}
          onDeleteEntry={hostFolder ? undefined : (entry) => void requestDelete(entry)}
          onEditSubmit={(value) => void submitEdit(value)}
          onEditCancel={cancelEdit}
          onToggleDirectory={toggleDirectory}
          onOpenFile={(path) => {
            if (dragMention.isDragInProgress()) return;
            onOpenFile(panelPath(path));
          }}
          onEntryContextMenu={showEntryContextMenu}
          onEntryDragStart={(entry, event) => {
            dragMention.handleSelectionChange([entry.path]);
            dragMention.handleDragStart(event.nativeEvent);
          }}
          onEntryDragEnd={() => dragMention.handleDragEnd(() => {})}
        />
      )}
    </div>
  );
}
