import type { EnvironmentId, VcsStatusResult } from "@houston-app/contracts";

import {
  branchLabel,
  repositoryErrorMessage,
  type RepositoryChangeFile,
  type RepositoryChoice,
} from "./multiRepositoryChanges.logic";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { DiffFileList, type DiffFileListEntry } from "../ui/diff-review-controls";
import {
  RepositoryChangesEmptyMessage,
  RepositoryChangesErrorRow,
  RepositoryChangesGroup,
  RepositoryChangesInlineError,
} from "../ui/repository-list";

interface MultiRepositoryChangesProps {
  readonly environmentId: EnvironmentId;
  readonly repositories: ReadonlyArray<RepositoryChoice>;
  readonly scope: "branch" | "unstaged";
  readonly baseRef: string | null;
  readonly ignoreWhitespace: boolean;
  readonly selectedRepositoryKey: string | null;
  readonly selectedPath: string | null;
  readonly onSelectFile: (repositoryKey: string, path: string) => void;
  readonly onRefreshRepositories: () => void;
}

const WORKING_TREE_STATUS: Record<string, string> = {
  untracked: "added",
  conflicted: "modified",
};

function workingTreeFileEntries(status: VcsStatusResult | null): RepositoryChangeFile[] {
  return (status?.workingTree.files ?? []).map((file) => ({
    path: file.path,
    additions: file.insertions,
    deletions: file.deletions,
    ...(file.status === undefined
      ? {}
      : { status: WORKING_TREE_STATUS[file.status] ?? file.status }),
  }));
}

export function MultiRepositoryChanges({
  environmentId,
  repositories,
  scope,
  baseRef,
  ignoreWhitespace,
  selectedRepositoryKey,
  selectedPath,
  onSelectFile,
  onRefreshRepositories,
}: MultiRepositoryChangesProps) {
  return (
    <div className="group/repository-changes flex flex-col gap-1 px-1.5 py-1.5">
      <RepositoryChangesEmptyMessage />
      {repositories.map((repository) =>
        repository.error === undefined ? (
          <RepositoryChangeSection
            key={repository.key}
            environmentId={environmentId}
            repository={repository}
            scope={scope}
            baseRef={baseRef}
            ignoreWhitespace={ignoreWhitespace}
            selected={selectedRepositoryKey === repository.key}
            selectedPath={selectedRepositoryKey === repository.key ? selectedPath : null}
            onSelectFile={onSelectFile}
            onRefreshRepositories={onRefreshRepositories}
          />
        ) : (
          <RepositoryReadError
            key={repository.key}
            environmentId={environmentId}
            repository={repository}
            onRefreshRepositories={onRefreshRepositories}
          />
        ),
      )}
    </div>
  );
}

function RepositoryChangeSection({
  environmentId,
  repository,
  scope,
  baseRef,
  ignoreWhitespace,
  selected,
  selectedPath,
  onSelectFile,
  onRefreshRepositories,
}: {
  readonly environmentId: EnvironmentId;
  readonly repository: RepositoryChoice;
  readonly scope: "branch" | "unstaged";
  readonly baseRef: string | null;
  readonly ignoreWhitespace: boolean;
  readonly selected: boolean;
  readonly selectedPath: string | null;
  readonly onSelectFile: (repositoryKey: string, path: string) => void;
  readonly onRefreshRepositories: () => void;
}) {
  const statusQuery = useEnvironmentQuery(
    vcsEnvironment.status({
      environmentId,
      input: { cwd: repository.root },
    }),
  );
  const previewQuery = useEnvironmentQuery(
    scope === "branch"
      ? reviewEnvironment.diffPreview({
          environmentId,
          input: {
            cwd: repository.root,
            ...(baseRef === null ? {} : { baseRef }),
            ignoreWhitespace,
            metadataOnly: true,
          },
        })
      : null,
  );
  const previewFiles =
    previewQuery.data?.sources.find((source) => source.kind === "branch-range")?.files ?? [];
  const files: RepositoryChangeFile[] =
    scope === "unstaged"
      ? workingTreeFileEntries(statusQuery.data)
      : previewFiles.map((file) => ({
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
        }));
  const additions =
    scope === "unstaged"
      ? (statusQuery.data?.workingTree.insertions ?? 0)
      : (statusQuery.data?.branchChanges?.insertions ??
        files.reduce((total, file) => total + file.additions, 0));
  const deletions =
    scope === "unstaged"
      ? (statusQuery.data?.workingTree.deletions ?? 0)
      : (statusQuery.data?.branchChanges?.deletions ??
        files.reduce((total, file) => total + file.deletions, 0));
  const loading = statusQuery.isPending || previewQuery.isPending;
  const branch = branchLabel({
    branch: statusQuery.data?.refName ?? repository.branch,
    detached: repository.detached || statusQuery.data?.refName === null,
  });

  if (!loading && files.length === 0) return null;
  const entries: ReadonlyArray<DiffFileListEntry> = files.map((file) => ({
    path: file.path,
    additions: file.additions,
    deletions: file.deletions,
    ...(file.status === undefined ? {} : { status: file.status }),
  }));

  return (
    <>
      {loading ? <span data-repository-loading="" aria-hidden className="h-0" /> : null}
      {files.length > 0 ? (
        <RepositoryChangesGroup
          name={repository.name}
          branch={branch}
          additions={additions}
          deletions={deletions}
        >
          <DiffFileList
            entries={entries}
            selectedPath={selectedPath}
            onSelectFile={(path) => onSelectFile(repository.key, path)}
          />
        </RepositoryChangesGroup>
      ) : null}
      {selected && statusQuery.error !== null ? (
        <RepositoryChangesInlineError>{statusQuery.error}</RepositoryChangesInlineError>
      ) : null}
      {statusQuery.error !== null || previewQuery.error !== null ? (
        <RepositoryChangesErrorRow
          message={statusQuery.error ?? previewQuery.error ?? "Could not read the repository."}
          retrying={loading}
          onRetry={() => {
            statusQuery.refresh();
            previewQuery.refresh();
            onRefreshRepositories();
          }}
        />
      ) : null}
    </>
  );
}

function RepositoryReadError({
  environmentId,
  repository,
  onRefreshRepositories,
}: {
  readonly environmentId: EnvironmentId;
  readonly repository: RepositoryChoice;
  readonly onRefreshRepositories: () => void;
}) {
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const statusQuery = useEnvironmentQuery(
    vcsEnvironment.status({ environmentId, input: { cwd: repository.root } }),
  );
  return (
    <div data-repository-changes="">
      <RepositoryChangesErrorRow
        message={repositoryErrorMessage(repository)}
        retrying={statusQuery.isPending}
        onRetry={() => {
          void refreshStatus({ environmentId, input: { cwd: repository.root } });
          onRefreshRepositories();
        }}
      />
    </div>
  );
}
