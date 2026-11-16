import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@houston-app/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@houston-app/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, PauseIcon, PlayIcon } from "lucide-react";
import { useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { mergeQueueEnvironment, useMergeQueueSnapshot } from "~/state/mergeQueue";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  MERGE_QUEUE_FIELD_ERROR,
  MERGE_QUEUE_HISTORY_ACTION,
  MERGE_QUEUE_HISTORY_LINE,
  MERGE_QUEUE_HISTORY_NUMBER,
  MERGE_QUEUE_HISTORY_TIME,
  MERGE_QUEUE_HISTORY_TITLE,
  MERGE_QUEUE_LINK_BUTTON,
  MERGE_QUEUE_SCOPE_NOTE,
  MERGE_QUEUE_SETTINGS_ERROR,
  MERGE_QUEUE_UNIT,
} from "../ui/merge-queue-recipes";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import {
  formatMergeQueueClock,
  mergeQueueCommandError,
  mergeQueueLogLine,
  mergeQueueSettingsError,
  mergeQueueTimeLimitError,
} from "../pullRequest/mergeQueue.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type SaveInput = {
  readonly mergeWhenVerified: boolean;
  readonly verificationCommand: string;
  readonly timeLimitMinutes: number;
};

function readableFailure(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The merge queue refused the change. Try again.";
}

export function MergeQueueSettingsSection({
  environmentId,
  projectId,
  title = "Merge queue",
  environmentLabel,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  title?: string;
  environmentLabel?: string | null;
}) {
  const navigate = useNavigate();
  const { snapshot, error, refresh } = useMergeQueueSnapshot(environmentId, projectId);
  const setSettings = useAtomCommand(mergeQueueEnvironment.setSettings, {
    reportFailure: false,
  });
  const pause = useAtomCommand(mergeQueueEnvironment.pause, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const [pendingPause, setPendingPause] = useState(false);
  const [commandDraft, setCommandDraft] = useState<string | null>(null);
  const [limitDraft, setLimitDraft] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [limitError, setLimitError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const settings = snapshot?.settings ?? null;
  // A draft outlives the host's answer only until the host confirms or refuses it.
  const command = commandDraft ?? settings?.verificationCommand ?? "";
  const limit = limitDraft ?? String(settings?.timeLimitMinutes ?? 30);

  const save = async (input: SaveInput): Promise<boolean> => {
    if (settings === null || saving) return false;
    const invalid = mergeQueueSettingsError(input);
    if (invalid !== null) {
      setRefusal(invalid);
      return false;
    }
    setSaving(true);
    setRefusal(null);
    const result = await setSettings({
      environmentId,
      input: {
        projectId,
        mergeWhenVerified: input.mergeWhenVerified,
        verificationCommand: input.verificationCommand,
        timeLimitMinutes: input.timeLimitMinutes,
        expectedRevision: settings.revision,
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setRefusal(readableFailure(squashAtomCommandFailure(result)));
      }
      return false;
    }
    return true;
  };

  const commitCommand = () => {
    const invalid = mergeQueueCommandError(command);
    setCommandError(invalid);
    if (invalid !== null || settings === null) return;
    if (command.trim() === settings.verificationCommand) {
      setCommandDraft(null);
      return;
    }
    void save({
      mergeWhenVerified: settings.mergeWhenVerified,
      verificationCommand: command,
      timeLimitMinutes: settings.timeLimitMinutes,
    }).then((saved) => {
      if (!saved) setCommandDraft(null);
    });
  };

  const commitLimit = () => {
    const minutes = Number(limit);
    const invalid = mergeQueueTimeLimitError(minutes);
    setLimitError(invalid);
    if (invalid !== null || settings === null) return;
    if (minutes === settings.timeLimitMinutes) {
      setLimitDraft(null);
      return;
    }
    void save({
      mergeWhenVerified: settings.mergeWhenVerified,
      verificationCommand: settings.verificationCommand,
      timeLimitMinutes: minutes,
    }).then((saved) => {
      if (!saved) setLimitDraft(null);
    });
  };

  const toggleProjectPause = async () => {
    if (settings === null) return;
    setPendingPause(true);
    const result = await pause({
      environmentId,
      input: { projectId, paused: !settings.paused },
    });
    setPendingPause(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not change the merge queue pause",
        description: readableFailure(squashAtomCommandFailure(result)),
      });
      return;
    }
    toastManager.add({ type: "success", title: result.value.message });
  };

  const toggleGlobalPause = async () => {
    if (snapshot === null) return;
    setPendingPause(true);
    const result = await pause({ environmentId, input: { paused: !snapshot.globalPaused } });
    setPendingPause(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not change every merge queue",
        description: readableFailure(squashAtomCommandFailure(result)),
      });
      return;
    }
    toastManager.add({ type: "success", title: result.value.message });
  };

  const disabled = settings === null || saving;
  const scopeNote = environmentLabel ? `${environmentLabel}` : null;
  const history = snapshot?.log ?? [];

  return (
    <>
      <SettingsSection
        id={`merge-queue-${environmentId}-${projectId}`}
        title={title}
        headerAction={
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void navigate({
                to: "/pull-requests",
                search: {
                  ...readPullRequestListPreferences(),
                  projectId,
                  environmentId,
                  view: "queue",
                },
              })
            }
          >
            Open queue
            <ArrowUpRightIcon className="size-3.5" />
          </Button>
        }
      >
        <SettingsRow
          title="Merge when verified"
          description={
            <>
              Houston pushes each verified head and merges it on its own. Off: you merge the
              verified head with Merge head.
              {scopeNote ? <span className={MERGE_QUEUE_SCOPE_NOTE}>{scopeNote}</span> : null}
            </>
          }
          control={
            <Switch
              aria-label="Merge when verified"
              checked={settings?.mergeWhenVerified ?? false}
              disabled={
                disabled ||
                ((settings?.verificationCommand.trim() ?? "") === "" &&
                  !settings?.mergeWhenVerified)
              }
              onCheckedChange={(checked) => {
                if (settings === null) return;
                void save({
                  mergeWhenVerified: checked,
                  verificationCommand: settings.verificationCommand,
                  timeLimitMinutes: settings.timeLimitMinutes,
                });
              }}
            />
          }
        />
        <SettingsRow
          title="Verification command"
          description="Runs in a scratch worktree after rebasing onto the base. A pull request cannot change it. At most 1,024 bytes."
          control={
            <div className="flex w-64 max-w-full flex-col items-end gap-1">
              <Input
                aria-label="Verification command"
                className="w-full"
                size="compact"
                placeholder="pnpm test:ci"
                value={command}
                disabled={disabled}
                onChange={(event) => {
                  setCommandDraft(event.target.value);
                  setCommandError(mergeQueueCommandError(event.target.value));
                }}
                onBlur={commitCommand}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              {commandError === null ? null : (
                <p className={MERGE_QUEUE_FIELD_ERROR} role="alert">
                  {commandError}
                </p>
              )}
            </div>
          }
        />
        <SettingsRow
          title="Time limit"
          description="A run past the limit counts as failed and is handed back. 1 to 240 minutes."
          control={
            <div className="flex flex-col items-end gap-1">
              <span className="inline-flex items-center gap-1.5">
                <Input
                  aria-label="Time limit in minutes"
                  className="w-20"
                  size="compact"
                  type="number"
                  min={1}
                  max={240}
                  step={1}
                  value={limit}
                  disabled={disabled}
                  onChange={(event) => {
                    setLimitDraft(event.target.value);
                    setLimitError(mergeQueueTimeLimitError(Number(event.target.value)));
                  }}
                  onBlur={commitLimit}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
                <span className={MERGE_QUEUE_UNIT}>min</span>
              </span>
              {limitError === null ? null : (
                <p className={MERGE_QUEUE_FIELD_ERROR} role="alert">
                  {limitError}
                </p>
              )}
            </div>
          }
        />
        <SettingsRow
          title="Queue"
          description="Pausing stops pushes and merges at once. Entries keep their place."
          control={
            <div className="flex items-center gap-2">
              <Badge
                size="sm"
                variant={settings === null ? "outline" : settings.paused ? "warning" : "success"}
              >
                {settings === null ? "Loading…" : settings.paused ? "Paused" : "Running"}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || pendingPause}
                onClick={() => void toggleProjectPause()}
              >
                {settings?.paused ? <PlayIcon /> : <PauseIcon />}
                {settings?.paused ? "Resume" : "Pause"}
              </Button>
            </div>
          }
        />
        <SettingsRow
          title="Every project"
          description="Pauses the merge queue of every project on this machine, beside each project's own pause."
          control={
            <div className="flex items-center gap-2">
              <Badge size="sm" variant={snapshot?.globalPaused ? "warning" : "success"}>
                {snapshot?.globalPaused ? "Paused" : "Running"}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                disabled={snapshot === null || pendingPause}
                onClick={() => void toggleGlobalPause()}
              >
                {snapshot?.globalPaused ? <PlayIcon /> : <PauseIcon />}
                {snapshot?.globalPaused ? "Resume all" : "Pause all"}
              </Button>
            </div>
          }
        />
      </SettingsSection>

      {refusal === null ? null : (
        <p className={MERGE_QUEUE_SETTINGS_ERROR} role="alert">
          {refusal}
        </p>
      )}
      {error === null ? null : (
        <p className={MERGE_QUEUE_SETTINGS_ERROR} role="alert">
          {error}{" "}
          <button type="button" className={MERGE_QUEUE_LINK_BUTTON} onClick={refresh}>
            Retry
          </button>
        </p>
      )}

      <SettingsSection
        title="Merge history"
        headerAction={
          <span className={MERGE_QUEUE_HISTORY_ACTION}>
            Pushes and merges the queue made, last 24 hours
          </span>
        }
      >
        {history.length === 0 ? (
          <SettingsRow
            title="Nothing yet"
            description="Pushes, merges and parks the queue makes appear here."
          />
        ) : (
          history.map((row) => (
            <SettingsRow
              key={`${row.kind}:${row.number}:${row.at}`}
              title={
                <span className={MERGE_QUEUE_HISTORY_TITLE}>
                  <span className={MERGE_QUEUE_HISTORY_TIME}>{formatMergeQueueClock(row.at)}</span>
                  <span className={MERGE_QUEUE_HISTORY_NUMBER}>#{row.number}</span>
                  <span className={MERGE_QUEUE_HISTORY_LINE}>{mergeQueueLogLine(row)}</span>
                </span>
              }
            />
          ))
        )}
      </SettingsSection>
    </>
  );
}
