import type { EnvironmentId } from "@houston-app/contracts";
import type { HoustonTaskSummary } from "@houston-app/contracts/houston/tasks";
import type { HoustonSlackInfo, HoustonSlackRequest } from "@houston-app/contracts/houston/slack";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLinkIcon, HashIcon } from "lucide-react";
import { AsyncResult } from "effect/reactivity";

import { readLocalApi } from "~/localApi";
import { slackEnvironment } from "~/state/slack";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, ListCard } from "../ui/card";
import { Glyph } from "../ui/glyph";
import { Empty, EmptyDescription, EmptyTitle } from "../ui/empty";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Text } from "../ui/text";
import { RelativeTime } from "../RelativeTime";
import { slackConnectionState, slackRequestLabel, slackRequestTone } from "./taskSources.logic";

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
      : `${info.team} · ${info.channels.length === 0 ? "no channels mapped" : `${info.channels.length} ${info.channels.length === 1 ? "channel" : "channels"} mapped`}`;
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
}: {
  environmentId: EnvironmentId;
  projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  tasks: ReadonlyArray<HoustonTaskSummary>;
  projectId: string | null;
  onProjectChange: (projectId: string) => void;
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
    />
  );
}

function TaskSourcesContent({
  environmentId,
  projects,
  tasks,
  projectId,
  onProjectChange,
}: {
  environmentId: EnvironmentId;
  projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  tasks: ReadonlyArray<HoustonTaskSummary>;
  projectId: string;
  onProjectChange: (projectId: string) => void;
}) {
  const slackInfoResult = useAtomValue(slackEnvironment.info({ environmentId, input: {} }));
  const slackRequestsResult = useAtomValue(slackEnvironment.requests({ environmentId, input: {} }));
  const slackInfo = AsyncResult.isSuccess(slackInfoResult) ? slackInfoResult.value : null;
  const slackError = AsyncResult.isFailure(slackInfoResult)
    ? "Slack could not be read; check its connection in Settings."
    : null;
  const slackRequests = AsyncResult.isSuccess(slackRequestsResult) ? slackRequestsResult.value : [];
  const projectRequests = slackRequests.filter((request) => request.projectId === projectId);
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  return (
    <div className="flex min-w-0 flex-col gap-5 pb-6">
      <div className="w-56 min-w-0">
        <Select
          value={projectId}
          onValueChange={(value) => {
            if (typeof value === "string") onProjectChange(value);
          }}
        >
          <SelectTrigger aria-label="Source workspace">
            <SelectValue>
              {projects.find((project) => project.id === projectId)?.title ?? "Choose a workspace"}
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

      {slackError === null ? null : (
        <Alert variant="error">
          <AlertDescription>{slackError}</AlertDescription>
        </Alert>
      )}

      <section className="flex min-w-0 flex-col gap-1.5">
        <div className="px-1">
          <Text as="h2" variant="caption" tone="muted" weight="semibold">
            Sources
          </Text>
        </div>
        <ListCard>
          <SlackSourceRow info={slackInfo} />
        </ListCard>
        <div className="px-1">
          <Text variant="caption" tone="muted" breakWords>
            Notion pages are issues now; a task can be created from a Notion issue on the Issues
            page.
          </Text>
        </div>
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
