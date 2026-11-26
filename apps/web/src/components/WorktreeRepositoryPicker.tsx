import type { EnvironmentId, ProjectId } from "@houston-app/contracts";
import { ChevronDownIcon, FolderGit2Icon } from "lucide-react";
import { useId, useState } from "react";

import { useWorktreeRepositories } from "~/state/worktreeRepositories";
import {
  filterWorktreeRepositories,
  selectableRepositoryKeys,
  worktreeRepositoryDisabledReason,
} from "~/state/worktreeRepositories.logic";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { ComposerControl } from "./chat/ComposerControl";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  REPOSITORY_PICKER_BASE_LABEL_CLASS,
  REPOSITORY_PICKER_BASE_SECTION_CLASS,
  REPOSITORY_PICKER_BRANCH_CLASS,
  REPOSITORY_PICKER_HEADER_CLASS,
  REPOSITORY_PICKER_ICON_CLASS,
  REPOSITORY_PICKER_LIST_CLASS,
  REPOSITORY_PICKER_MESSAGE_CLASS,
  REPOSITORY_PICKER_NAME_CLASS,
  REPOSITORY_PICKER_POPUP_CLASS,
  REPOSITORY_PICKER_REASON_CLASS,
  REPOSITORY_PICKER_ROW_CLASS,
  REPOSITORY_PICKER_ROW_DISABLED_CLASS,
  REPOSITORY_PICKER_TITLE_CLASS,
} from "./ui/composer-picker-recipes";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { Input } from "./ui/input";
import { MiddleTruncate } from "./ui/middle-truncate";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";

interface WorktreeRepositoryPickerProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly displayMode?: "toolbar" | "panel";
  readonly baseBranch: string | null;
  readonly fallbackBranch: string | null;
  readonly onBaseBranchChange: (branch: string | null) => void;
}

/** The choices for a multi-repository worktree, replacing the base-branch picker. */
export function WorktreeRepositoryPicker({
  environmentId,
  projectId,
  displayMode = "toolbar",
  baseBranch,
  fallbackBranch,
  onBaseBranchChange,
}: WorktreeRepositoryPickerProps) {
  const selection = useWorktreeRepositories({
    environmentId,
    projectId,
    enabled: true,
  });
  const composerFloatingLayerProps = useComposerMenuProps();
  const baseBranchId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  if (!selection.usesRepositoryChoice) return null;

  const selectableCount = selectableRepositoryKeys(selection.repositories).length;
  const filtered = filterWorktreeRepositories(selection.repositories, query);
  const noneChosen = selection.repositories.length > 0 && selection.selectedKeys.length === 0;
  const isPanel = displayMode === "panel";

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          isPanel ? (
            <ThreadDetailsControl part="select" />
          ) : (
            <ComposerControl size="xs" data-composer-context-control />
          )
        }
        aria-label={`Repositories: ${selection.summaryLabel}`}
      >
        <FolderGit2Icon aria-hidden="true" className={REPOSITORY_PICKER_ICON_CLASS} />
        <ComposerContextLabel>
          <MiddleTruncate value={selection.summaryLabel} className="w-full" />
        </ComposerContextLabel>
        <ChevronDownIcon aria-hidden="true" className={REPOSITORY_PICKER_ICON_CLASS} />
      </PopoverTrigger>
      <PopoverPopup
        side={isPanel ? "bottom" : "top"}
        align={isPanel ? "start" : "end"}
        padding="none"
        {...(isPanel ? {} : composerFloatingLayerProps)}
      >
        <div className={REPOSITORY_PICKER_POPUP_CLASS}>
          <div className={REPOSITORY_PICKER_HEADER_CLASS}>
            <span className={REPOSITORY_PICKER_TITLE_CLASS}>Repositories</span>
            <span className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                size="micro"
                variant="ghost-muted"
                disabled={selectableCount === 0}
                onClick={selection.selectAll}
              >
                All
              </Button>
              <Button
                type="button"
                size="micro"
                variant="ghost-muted"
                disabled={selection.selectedKeys.length === 0}
                onClick={selection.selectNone}
              >
                None
              </Button>
            </span>
          </div>
          {selection.searchable ? (
            <div className="px-2 py-1.5">
              <Input
                type="search"
                size="compact"
                aria-label="Search repositories"
                placeholder="Search repositories…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          ) : null}
          <div className={REPOSITORY_PICKER_LIST_CLASS}>
            {selection.repositories.length === 0 ? (
              <Empty size="compact" className="min-h-0">
                <EmptyHeader>
                  <EmptyTitle>No repositories</EmptyTitle>
                  <EmptyDescription>
                    This project has no repository Houston can use for a worktree.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : filtered.length === 0 ? (
              <p className={REPOSITORY_PICKER_MESSAGE_CLASS}>No repositories match.</p>
            ) : (
              filtered.map((repository) => {
                const disabledReason = worktreeRepositoryDisabledReason(repository);
                const checkboxId = `worktree-repository-${baseBranchId}-${repository.key}`;
                const reasonId = `${checkboxId}-reason`;
                const checked = selection.selectedKeys.includes(repository.key);
                const rowClassName =
                  disabledReason === null
                    ? REPOSITORY_PICKER_ROW_CLASS
                    : `${REPOSITORY_PICKER_ROW_CLASS} ${REPOSITORY_PICKER_ROW_DISABLED_CLASS}`;
                return (
                  <label key={repository.key} htmlFor={checkboxId} className={rowClassName}>
                    <Checkbox
                      id={checkboxId}
                      className="mt-0.5"
                      checked={checked}
                      disabled={disabledReason !== null}
                      aria-describedby={disabledReason === null ? undefined : reasonId}
                      onCheckedChange={(nextChecked) => {
                        const wanted = new Set(selection.selectedKeys);
                        if (nextChecked === true) wanted.add(repository.key);
                        else wanted.delete(repository.key);
                        selection.setSelectedKeys([...wanted]);
                      }}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span data-repository-name="" className={REPOSITORY_PICKER_NAME_CLASS}>
                          <MiddleTruncate value={repository.name} className="w-full" />
                        </span>
                        {repository.branch === null ? null : (
                          <span
                            data-repository-branch=""
                            className={REPOSITORY_PICKER_BRANCH_CLASS}
                          >
                            <MiddleTruncate value={repository.branch} className="w-full" />
                          </span>
                        )}
                      </span>
                      {disabledReason === null ? null : (
                        <span id={reasonId} className={REPOSITORY_PICKER_REASON_CLASS}>
                          {disabledReason}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })
            )}
          </div>
          {noneChosen ? (
            <div className="px-2 py-1.5">
              <Alert variant="warning">
                <AlertDescription>
                  Choose at least one repository to start a worktree.
                </AlertDescription>
              </Alert>
            </div>
          ) : null}
          <div className={REPOSITORY_PICKER_BASE_SECTION_CLASS}>
            <label htmlFor={baseBranchId} className={REPOSITORY_PICKER_BASE_LABEL_CLASS}>
              Start from this branch where a repository has it
            </label>
            <Input
              id={baseBranchId}
              size="compact"
              font="mono"
              aria-label="Base branch"
              value={baseBranch ?? ""}
              placeholder={fallbackBranch ?? "Each repository's current branch"}
              onChange={(event) => {
                const next = event.target.value;
                onBaseBranchChange(next.trim().length === 0 ? null : next);
              }}
            />
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
