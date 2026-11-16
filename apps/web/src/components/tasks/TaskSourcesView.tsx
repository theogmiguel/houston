import type { EnvironmentId, ProjectId } from "@houston-app/contracts";
import type {
  HoustonTaskSourceSettings,
  HoustonTaskSourceSettingsInput,
} from "@houston-app/contracts/houston/taskSources";
import type { HoustonTaskSummary } from "@houston-app/contracts/houston/tasks";
import type { HoustonSlackInfo, HoustonSlackRequest } from "@houston-app/contracts/houston/slack";
import { squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  CircleDotIcon,
  ExternalLinkIcon,
  FileTextIcon,
  HashIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";
import { AsyncResult } from "effect/reactivity";

import { readLocalApi } from "~/localApi";
import { slackEnvironment } from "~/state/slack";
import { taskSourcesEnvironment } from "~/state/taskSources";
import { useAtomCommand } from "~/state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, ListCard } from "../ui/card";
import { Glyph } from "../ui/glyph";
import { Empty, EmptyDescription, EmptyTitle } from "../ui/empty";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { Text } from "../ui/text";
import { toastManager } from "../ui/toast";
import { RelativeTime } from "../RelativeTime";
import {
  conflictLabel,
  settingsInputFrom,
  slackConnectionState,
  slackRequestLabel,
  slackRequestTone,
  taskSourceProviderLabel,
  taskSourceState,
} from "./taskSources.logic";

const PROVIDER_ICONS = {
  github_issues: CircleDotIcon,
  notion: FileTextIcon,
} as const;

function readableFailure(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "The source request failed.";
}

function stateBadge(state: { label: string; tone: "success" | "error" | "default" }) {
  if (state.tone === "success") return <Badge variant="success">{state.label}</Badge>;
  if (state.tone === "error") return <Badge variant="error">{state.label}</Badge>;
  return <Badge>{state.label}</Badge>;
}

function openExternal(url: string): void {
  const api = readLocalApi();
  if (api == null) {
    window.open(url, "_blank", "noreferrer");
    return;
  }
  void api.shell.openExternal(url);
}

function SlackSourceRow({ info }: { info: HoustonSlackInfo | null }) {
  const navigate = useNavigate();
  if (info === null) {
    return <Skeleton className="h-16 w-full" />;
  }
  const state = slackConnectionState(info);
  const description =
    info.team === null
      ? "No Slack workspace is connected."
      : `${info.team} · ${info.channels.length === 0 ? "no channels mapped" : `${info.channels.length} ${info.channels.length === 1 ? "channel" : "channels"} mapped`}${
          info.lastEventAt === null ? "" : " · "
        }`;
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2 px-3.5 py-3">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <Glyph icon={HashIcon} className="mt-0.5 size-4" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Text as="h3" variant="headline" weight="medium">
              Slack
            </Text>
            {stateBadge(state)}
          </div>
          <Text variant="caption" tone="muted" breakWords>
            {description}
            {info.lastEventAt === null ? null : <RelativeTime timestamp={info.lastEventAt} />}
          </Text>
          {info.error === null ? null : (
            <Text variant="caption" tone="danger" breakWords>
              {info.error}
            </Text>
          )}
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={() => void navigate({ to: "/settings/task-sources" })}
      >
        {info.enabled ? "Configure" : "Connect Slack"}
      </Button>
    </div>
  );
}

function ProviderSourceRow({
  environmentId,
  settings,
}: {
  environmentId: EnvironmentId;
  settings: HoustonTaskSourceSettings;
}) {
  const navigate = useNavigate();
  const saveSettings = useAtomCommand(taskSourcesEnvironment.saveSettings);
  const [busy, setBusy] = useState(false);
  const state = taskSourceState(settings);
  const Icon = PROVIDER_ICONS[settings.provider];
  const description =
    settings.provider === "github_issues"
      ? settings.githubRepository === null
        ? "No repository configured."
        : `${settings.githubRepository}${settings.githubLabel === null ? "" : ` · label ${settings.githubLabel}`}`
      : settings.notionDataSourceId === null
        ? "No Notion data source configured."
        : `Data source ${settings.notionDataSourceId}`;

  const setEnabled = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    const outcome = await saveSettings({
      environmentId,
      input: {
        projectId: settings.projectId,
        provider: settings.provider,
        expectedRevision: settings.revision,
        settings: settingsInputFrom(settings, { enabled }) satisfies HoustonTaskSourceSettingsInput,
      },
    });
    setBusy(false);
    if (outcome._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `${taskSourceProviderLabel(settings.provider)} not changed`,
        description: readableFailure(squashAtomCommandFailure(outcome)),
      });
    }
  };

  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2 px-3.5 py-3">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <Glyph icon={Icon} className="mt-0.5 size-4" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Text as="h3" variant="headline" weight="medium">
              {taskSourceProviderLabel(settings.provider)}
            </Text>
            {stateBadge(state)}
          </div>
          <Text variant="caption" tone="muted" breakWords>
            {description}
            {settings.lastError !== null || settings.lastSyncAt === null ? null : " · synced "}
            {settings.lastError !== null || settings.lastSyncAt === null ? null : (
              <RelativeTime timestamp={settings.lastSyncAt} />
            )}
          </Text>
          {settings.lastError === null ? null : (
            <Text variant="caption" tone="danger" breakWords>
              {settings.lastError}
            </Text>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Switch
          size="sm"
          checked={settings.enabled}
          disabled={busy}
          aria-label={`Sync ${taskSourceProviderLabel(settings.provider)}`}
          onCheckedChange={(checked) => void setEnabled(Boolean(checked))}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => void navigate({ to: "/settings/task-sources" })}
        >
          {settings.provider === "notion" &&
          (!settings.hasCredential || settings.lastError !== null)
            ? "Update token"
            : "Configure"}
        </Button>
      </div>
    </div>
  );
}

function SlackRequestRow({
  request,
  task,
}: {
  request: HoustonSlackRequest;
  task: HoustonTaskSummary | null;
}) {
  const tone = slackRequestTone(request);
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Text variant="callout" breakWords>
          {task === null ? `Task ${request.taskId ?? "not filed"}` : `${task.key} ${task.title}`}
        </Text>
        <Text variant="caption" tone="muted" breakWords>
          @{request.author} in {request.channelId}
        </Text>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Badge variant={tone}>{slackRequestLabel(request)}</Badge>
        {request.permalink === null ? null : (
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label="Open in Slack"
            onClick={() => openExternal(request.permalink as string)}
          >
            <ExternalLinkIcon aria-hidden />
          </Button>
        )}
      </div>
    </div>
  );
}

export function TaskSourcesView({
  environmentId,
  projects,
  tasks,
  projectId,
  onProjectChange,
  onOpenTask,
}: {
  environmentId: EnvironmentId;
  projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  tasks: ReadonlyArray<HoustonTaskSummary>;
  projectId: string | null;
  onProjectChange: (projectId: string) => void;
  onOpenTask: (taskKey: string) => void;
}) {
  if (projectId === null) {
    return (
      <Empty size="compact">
        <EmptyTitle>No workspace to configure</EmptyTitle>
        <EmptyDescription>Source settings belong to a workspace.</EmptyDescription>
      </Empty>
    );
  }
  return (
    <TaskSourcesContent
      environmentId={environmentId}
      projects={projects}
      tasks={tasks}
      projectId={projectId}
      onProjectChange={onProjectChange}
      onOpenTask={onOpenTask}
    />
  );
}

function TaskSourcesContent({
  environmentId,
  projects,
  tasks,
  projectId,
  onProjectChange,
  onOpenTask,
}: {
  environmentId: EnvironmentId;
  projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  tasks: ReadonlyArray<HoustonTaskSummary>;
  projectId: string;
  onProjectChange: (projectId: string) => void;
  onOpenTask: (taskKey: string) => void;
}) {
  const typedProjectId = projectId as ProjectId;
  const syncNow = useAtomCommand(taskSourcesEnvironment.syncNow);
  const [syncing, setSyncing] = useState(false);
  const settingsResult = useAtomValue(
    taskSourcesEnvironment.settings({ environmentId, input: { projectId: typedProjectId } }),
  );
  const conflictsResult = useAtomValue(
    taskSourcesEnvironment.conflicts({ environmentId, input: { projectId: typedProjectId } }),
  );
  const slackInfoResult = useAtomValue(slackEnvironment.info({ environmentId, input: {} }));
  const slackRequestsResult = useAtomValue(slackEnvironment.requests({ environmentId, input: {} }));

  const settings = AsyncResult.isSuccess(settingsResult) ? settingsResult.value : null;
  const settingsError = AsyncResult.isFailure(settingsResult)
    ? readableFailure(squashAtomCommandFailure(settingsResult))
    : null;
  const conflicts = AsyncResult.isSuccess(conflictsResult) ? conflictsResult.value : [];
  const slackInfo = AsyncResult.isSuccess(slackInfoResult) ? slackInfoResult.value : null;
  const slackError = AsyncResult.isFailure(slackInfoResult)
    ? readableFailure(squashAtomCommandFailure(slackInfoResult))
    : null;
  const slackRequests = AsyncResult.isSuccess(slackRequestsResult) ? slackRequestsResult.value : [];
  const projectRequests = slackRequests.filter((request) => request.projectId === typedProjectId);
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  const runSyncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    const outcome = await syncNow({ environmentId, input: { projectId: typedProjectId } });
    setSyncing(false);
    if (outcome._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Sources not synced",
        description: readableFailure(squashAtomCommandFailure(outcome)),
      });
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-5 pb-6">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="w-56 min-w-0">
          <Select
            value={projectId}
            onValueChange={(value) => {
              if (typeof value === "string") onProjectChange(value);
            }}
          >
            <SelectTrigger aria-label="Source workspace">
              <SelectValue>
                {projects.find((project) => project.id === projectId)?.title ??
                  "Choose a workspace"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <Button size="sm" variant="outline" disabled={syncing} onClick={() => void runSyncNow()}>
          <RefreshCwIcon aria-hidden />
          Sync now
        </Button>
      </div>

      {settingsError === null ? null : (
        <Alert variant="error">
          <AlertDescription>{settingsError}</AlertDescription>
        </Alert>
      )}
      {slackError === null ? null : (
        <Alert variant="error">
          <AlertDescription>{slackError}</AlertDescription>
        </Alert>
      )}

      <section className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2 px-1">
          <Text as="h2" variant="caption" tone="muted" weight="semibold">
            Needs a decision
          </Text>
          {conflicts.length === 0 ? null : <Badge variant="warning">{conflicts.length}</Badge>}
        </div>
        {conflicts.length === 0 ? (
          <Card>
            <Text variant="caption" tone="muted">
              Houston and every connected source agree.
            </Text>
          </Card>
        ) : (
          <div className="flex min-w-0 flex-col gap-1.5">
            {conflicts.map((entry) => (
              <Card
                key={`${entry.link.provider}:${entry.link.externalId}`}
                className="flex min-w-0 flex-col"
              >
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-1 items-start gap-2">
                    <Glyph icon={TriangleAlertIcon} tone="warning" className="mt-0.5 size-4" />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <Text variant="callout" breakWords>
                        <Text as="span" variant="caption" mono tone="muted">
                          {entry.taskKey}
                        </Text>{" "}
                        {entry.taskTitle}
                      </Text>
                      <Text variant="caption" tone="muted" breakWords>
                        {conflictLabel(entry.link.provider, entry.link.snapshot.conflicts)}
                      </Text>
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => onOpenTask(entry.taskKey)}>
                    Resolve
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="flex min-w-0 flex-col gap-1.5">
        <div className="px-1">
          <Text as="h2" variant="caption" tone="muted" weight="semibold">
            Sources
          </Text>
        </div>
        <ListCard>
          <SlackSourceRow info={slackInfo} />
          {settings === null ? (
            <div className="px-3.5 py-3">
              <Skeleton className="h-14 w-full" />
            </div>
          ) : (
            settings.map((entry) => (
              <ProviderSourceRow
                key={entry.provider}
                environmentId={environmentId}
                settings={entry}
              />
            ))
          )}
        </ListCard>
      </section>

      <section className="flex min-w-0 flex-col gap-1.5">
        <div className="px-1">
          <Text as="h2" variant="caption" tone="muted" weight="semibold">
            Slack requests
          </Text>
        </div>
        {projectRequests.length === 0 ? (
          <Card>
            <Empty size="compact">
              <EmptyTitle>No Slack requests yet</EmptyTitle>
              <EmptyDescription>
                A mention in a mapped channel files a request here.
              </EmptyDescription>
            </Empty>
          </Card>
        ) : (
          <ListCard>
            {projectRequests.map((request, index) => (
              <SlackRequestRow
                key={`${request.channelId}:${request.taskId ?? index}`}
                request={request}
                task={request.taskId === null ? null : (taskById.get(request.taskId) ?? null)}
              />
            ))}
          </ListCard>
        )}
      </section>
    </div>
  );
}
