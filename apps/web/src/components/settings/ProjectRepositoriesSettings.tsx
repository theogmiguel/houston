import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
} from "@houston-app/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@houston-app/client-runtime/state/runtime";
import { AlertCircleIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentScope } from "~/state/session";
import { projectRepositories } from "~/state/projectRepositories";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Input } from "../ui/input";
import { Text } from "../ui/text";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  addTrackedFolderDisabledReason,
  ignorePatternsDirty,
  ignorePatternsText,
  parseIgnorePatterns,
  repositoryBranchLabel,
  repositoryFailureMessage,
  repositoryNoticeMessage,
  repositoryReadError,
  showRepositoryLists,
  splitProjectRepositories,
  trackedFolderCounter,
} from "./projectRepositories.logic";

const REPOSITORIES_SECTION_ID = "project-repositories";
const WRITE_DENIED = "This connection cannot change this project's repositories.";
const ADD_EMPTY = "Type an absolute folder path to add it.";

export function ProjectRepositoriesSettings({
  environmentId,
  projectId,
  title = "Repositories",
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  title?: string;
}) {
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const query = useEnvironmentQuery(
    projectRepositories.list({ environmentId, input: { projectId } }),
  );
  const track = useAtomCommand(projectRepositories.track, { reportFailure: false });
  const untrack = useAtomCommand(projectRepositories.untrack, { reportFailure: false });
  const setIgnorePatterns = useAtomCommand(projectRepositories.setIgnorePatterns, {
    reportFailure: false,
  });

  const [folderDraft, setFolderDraft] = useState("");
  const [ignoreDraft, setIgnoreDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [savingIgnore, setSavingIgnore] = useState(false);

  if (query.data === null) {
    if (query.error === null) return null;
    return (
      <SettingsSection id={REPOSITORIES_SECTION_ID} title={title}>
        <div className="p-3">
          <Alert variant="error">
            <AlertCircleIcon aria-hidden />
            <AlertDescription>{query.error}</AlertDescription>
            <AlertAction>
              <Button size="sm" variant="outline" onClick={query.refresh}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        </div>
      </SettingsSection>
    );
  }

  const data = query.data;
  const lists = splitProjectRepositories(data.repositories);
  const counter = trackedFolderCounter(lists.tracked.length);
  const addDisabledReason = !canOperate
    ? WRITE_DENIED
    : addTrackedFolderDisabledReason(lists.tracked.length);
  const addStatus = addDisabledReason ?? (folderDraft.trim().length === 0 ? ADD_EMPTY : null);
  const savedPatterns = data.ignored;
  const savedText = ignorePatternsText(savedPatterns);
  const ignoreText = ignoreDraft ?? savedText;
  const ignoreDirty = ignorePatternsDirty(savedPatterns, ignoreText);
  const saveDisabledReason = !canOperate
    ? WRITE_DENIED
    : savingIgnore
      ? "Saving…"
      : ignoreDirty
        ? null
        : "No changes to save.";

  const run = async <T,>(
    command: () => Promise<AtomCommandResult<T, unknown>>,
    onSuccess: () => void,
  ) => {
    setError(null);
    const result = await command();
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(repositoryFailureMessage(squashAtomCommandFailure(result)));
      }
      return false;
    }
    onSuccess();
    return true;
  };

  const addFolder = async () => {
    const path = folderDraft.trim();
    if (path.length === 0 || addDisabledReason !== null || busy) return;
    setBusy(true);
    await run(
      () => track({ environmentId, input: { projectId, path } }),
      () => setFolderDraft(""),
    );
    setBusy(false);
  };

  const removeFolder = async (path: string) => {
    if (!canOperate || busy) return;
    setRemoving(path);
    await run(
      () => untrack({ environmentId, input: { projectId, path } }),
      () => undefined,
    );
    setRemoving(null);
  };

  const saveIgnore = async () => {
    if (!canOperate || savingIgnore || !ignoreDirty) return;
    setSavingIgnore(true);
    await run(
      () =>
        setIgnorePatterns({
          environmentId,
          input: { projectId, patterns: parseIgnorePatterns(ignoreText) },
        }),
      () => setIgnoreDraft(null),
    );
    setSavingIgnore(false);
  };

  if (
    !showRepositoryLists({
      repositories: data.repositories,
      trackedCount: lists.tracked.length,
      ignoredCount: savedPatterns.length,
      noticeCount: data.notices.length,
    })
  ) {
    return (
      <SettingsSection id={REPOSITORIES_SECTION_ID} title={title}>
        <SettingsRow
          title="Repositories"
          description="This project has one repository. Add a folder that lives elsewhere on disk to cover it too."
          status={addStatus}
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={addDisabledReason !== null || busy || folderDraft.trim().length === 0}
              title={addDisabledReason ?? undefined}
              onClick={() => void addFolder()}
            >
              <PlusIcon />
              Add folder…
            </Button>
          }
        >
          <div className="flex flex-col gap-2 pb-1 sm:flex-row sm:items-center">
            <Input
              size="compact"
              font="mono"
              aria-label="Folder path to add"
              placeholder="/absolute/path/to/repository"
              value={folderDraft}
              disabled={addDisabledReason !== null || busy}
              onChange={(event) => setFolderDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addFolder();
              }}
            />
          </div>
          {error !== null ? (
            <div className="pt-2">
              <Alert variant="error">
                <AlertCircleIcon aria-hidden />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            </div>
          ) : null}
        </SettingsRow>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection id={REPOSITORIES_SECTION_ID} title={title}>
      {data.notices.length > 0 ? (
        <div className="p-3">
          <Alert variant="warning">
            <AlertCircleIcon aria-hidden />
            {data.notices.map((notice) => (
              <AlertDescription
                key={`${notice.limit}:${notice.limitValue}:${notice.actual}:${notice.requested}`}
              >
                {repositoryNoticeMessage(notice)}
              </AlertDescription>
            ))}
          </Alert>
        </div>
      ) : null}
      {error !== null ? (
        <div className="p-3">
          <Alert variant="error">
            <AlertCircleIcon aria-hidden />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      ) : null}
      <SettingsRow
        title="Found in the project folder"
        description="Discovered repositories, including each submodule."
      />
      {lists.found.length === 0 ? (
        <div className="px-4 py-4">
          <Empty size="compact">
            <EmptyHeader>
              <EmptyTitle>No repositories found</EmptyTitle>
              <EmptyDescription>
                The project folder and its children hold no git repositories.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        lists.found.map((repository) => {
          const readError = repositoryReadError(repository);
          return (
            <SettingsRow
              key={`${repository.kind}:${repository.key}`}
              title={
                <Text as="span" variant="callout" mono>
                  <MiddleTruncate value={repository.key} />
                </Text>
              }
              description={
                readError === null ? undefined : (
                  <Text as="span" variant="callout" tone="danger">
                    {readError}
                  </Text>
                )
              }
              control={
                <div className="flex items-center gap-2">
                  {repository.kind === "submodule" ? (
                    <Badge size="sm" variant="outline">
                      Submodule
                    </Badge>
                  ) : null}
                  <Text variant="callout" tone="muted" mono>
                    {repositoryBranchLabel(repository)}
                  </Text>
                  {readError === null ? null : (
                    <Button size="sm" variant="outline" onClick={query.refresh}>
                      Retry
                    </Button>
                  )}
                </div>
              }
            />
          );
        })
      )}
      <SettingsRow
        title="Added folders"
        description="Git repositories outside the project folder that this project covers."
        control={
          counter.visible ? (
            <Badge variant={counter.tone === "warning" ? "warning" : "outline"}>
              {counter.label}
            </Badge>
          ) : null
        }
      />
      {lists.tracked.length === 0 ? (
        <div className="px-4 py-4">
          <Empty size="compact">
            <EmptyHeader>
              <EmptyTitle>No added folders</EmptyTitle>
              <EmptyDescription>
                This project covers only repositories inside its folder.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        lists.tracked.map((repository) => (
          <SettingsRow
            key={`${repository.kind}:${repository.root}`}
            title={
              <Text as="span" variant="callout" mono>
                <MiddleTruncate value={repository.root} />
              </Text>
            }
            description={
              repository.error === undefined ? undefined : (
                <Text as="span" variant="callout" tone="danger">
                  {repositoryReadError(repository)}
                </Text>
              )
            }
            control={
              <div className="flex items-center gap-2">
                <Text variant="callout" tone="muted" mono>
                  {repositoryBranchLabel(repository)}
                </Text>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canOperate || busy}
                  title={!canOperate ? WRITE_DENIED : undefined}
                  aria-label={`Stop covering ${repository.root}`}
                  onClick={() => void removeFolder(repository.root)}
                >
                  {removing === repository.root ? "Removing…" : "Remove"}
                </Button>
              </div>
            }
          />
        ))
      )}
      <SettingsRow
        title="Add folder"
        description="An absolute path to a git repository that lives outside the project folder."
        status={addStatus}
      >
        <div className="flex flex-col gap-2 pb-1 sm:flex-row sm:items-center">
          <Input
            size="compact"
            font="mono"
            aria-label="Folder path to add"
            placeholder="/absolute/path/to/repository"
            value={folderDraft}
            disabled={addDisabledReason !== null || busy}
            onChange={(event) => setFolderDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void addFolder();
            }}
          />
          <Button
            size="sm"
            variant="outline"
            className="sm:shrink-0"
            disabled={addDisabledReason !== null || busy || folderDraft.trim().length === 0}
            title={addDisabledReason ?? undefined}
            onClick={() => void addFolder()}
          >
            <PlusIcon />
            Add folder…
          </Button>
        </div>
      </SettingsRow>
      <SettingsRow
        title="Ignored"
        description="One glob per line. A pattern matches a repository's path or folder name; * stays within one segment and ** crosses them. Patterns come from this project's saved list and the repository's houston.json."
      >
        <div className="flex flex-col gap-2 pb-1">
          <Textarea
            font="mono"
            rows={4}
            aria-label="Ignored repository patterns"
            value={ignoreText}
            disabled={!canOperate}
            onChange={(event) => setIgnoreDraft(event.currentTarget.value)}
          />
          <div className="flex items-center justify-between gap-2">
            <Text as="p" variant="caption" tone="muted">
              Saving replaces this project's saved list. A pattern in houston.json stays ignored.
            </Text>
            <div className="flex shrink-0 items-center gap-2">
              {saveDisabledReason === null ? null : (
                <Text variant="caption" tone="muted">
                  {saveDisabledReason}
                </Text>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={saveDisabledReason !== null}
                title={saveDisabledReason ?? undefined}
                onClick={() => void saveIgnore()}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
