import type { EnvironmentId } from "@houston-app/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  CircleDotIcon,
  ExternalLinkIcon,
  FileTextIcon,
  HashIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { AsyncResult } from "effect/reactivity";

import { readLocalApi } from "~/localApi";
import { slackEnvironment } from "~/state/slack";
import { taskSourcesEnvironment } from "~/state/taskSources";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Glyph } from "../ui/glyph";
import { Text } from "../ui/text";
import { TaskSourceConflictResolver } from "./TaskSourceConflictResolver";
import { slackRequestLabel, slackRequestTone, taskSourceProviderLabel } from "./taskSources.logic";

const PROVIDER_ICONS = {
  github_issues: CircleDotIcon,
  notion: FileTextIcon,
} as const;

function openExternal(url: string): void {
  const api = readLocalApi();
  if (api == null) {
    window.open(url, "_blank", "noreferrer");
    return;
  }
  void api.shell.openExternal(url);
}

function linkStateLabel(state: "current" | "diverged" | "pending" | "error"): string {
  switch (state) {
    case "current":
      return "Synced";
    case "diverged":
      return "Needs a decision";
    case "pending":
      return "Pending";
    case "error":
      return "Failed";
  }
}

export function TaskSourceLinks({
  environmentId,
  taskKey,
  taskId,
  taskRevision,
  refUrl,
}: {
  environmentId: EnvironmentId;
  taskKey: string;
  taskId: number;
  taskRevision: number;
  refUrl: string | null;
}) {
  const linksResult = useAtomValue(
    taskSourcesEnvironment.links({ environmentId, input: { taskId: taskKey } }),
  );
  const conflictsResult = useAtomValue(
    taskSourcesEnvironment.conflicts({ environmentId, input: {} }),
  );
  const slackRequestsResult = useAtomValue(slackEnvironment.requests({ environmentId, input: {} }));
  const links = AsyncResult.isSuccess(linksResult) ? linksResult.value : [];
  const conflictEntries = AsyncResult.isSuccess(conflictsResult) ? conflictsResult.value : [];
  const slackRequest = (
    AsyncResult.isSuccess(slackRequestsResult) ? slackRequestsResult.value : []
  ).find((request) => request.taskId === taskId);
  if (links.length === 0 && slackRequest === undefined && refUrl === null) return null;

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <Text variant="caption" tone="muted" weight="medium">
        Source
      </Text>
      {links.map((link) => {
        const Icon = PROVIDER_ICONS[link.provider];
        const entry = conflictEntries.find(
          (candidate) =>
            candidate.taskId === taskId &&
            candidate.link.provider === link.provider &&
            candidate.link.externalId === link.externalId,
        );
        return (
          <Card key={`${link.provider}:${link.externalId}`}>
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-1.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Glyph icon={Icon} className="size-3.5" />
                  <Text variant="callout" weight="medium">
                    {taskSourceProviderLabel(link.provider)}
                  </Text>
                  <Badge
                    variant={
                      link.syncState.state === "error"
                        ? "error"
                        : link.syncState.state === "diverged"
                          ? "warning"
                          : "default"
                    }
                  >
                    {linkStateLabel(link.syncState.state)}
                  </Badge>
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost-muted"
                  aria-label={`Open in ${taskSourceProviderLabel(link.provider)}`}
                  onClick={() => openExternal(link.url)}
                >
                  <ExternalLinkIcon aria-hidden />
                </Button>
              </div>
              {link.syncState.state === "error" ? (
                <Text variant="caption" tone="danger" breakWords>
                  {link.syncState.message}
                </Text>
              ) : null}
              {link.snapshot.conflicts.length === 0 ? null : (
                <div className="flex min-w-0 items-center gap-1.5">
                  <Glyph icon={TriangleAlertIcon} tone="warning" className="size-3.5" />
                  <Text variant="caption" tone="warning">
                    {link.snapshot.conflicts.length} field
                    {link.snapshot.conflicts.length === 1 ? "" : "s"} differ
                  </Text>
                </div>
              )}
              <TaskSourceConflictResolver
                environmentId={environmentId}
                taskKey={taskKey}
                taskRevision={entry?.taskRevision ?? taskRevision}
                initiativeRevision={entry?.initiativeRevision ?? null}
                link={link}
              />
            </div>
          </Card>
        );
      })}
      {slackRequest === undefined ? null : (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <Glyph icon={HashIcon} className="size-3.5" />
            <Text variant="caption" tone="muted">
              Slack · {slackRequest.channelId} · @{slackRequest.author}
            </Text>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant={slackRequestTone(slackRequest)}>
              {slackRequestLabel(slackRequest)}
            </Badge>
            {slackRequest.permalink === null ? null : (
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label="Open in Slack"
                onClick={() => openExternal(slackRequest.permalink as string)}
              >
                <ExternalLinkIcon aria-hidden />
              </Button>
            )}
          </div>
        </div>
      )}
      {links.length > 0 || refUrl === null ? null : (
        <div className="flex min-w-0 items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => openExternal(refUrl)}>
            <Text as="span" variant="callout" tone="accent" truncate>
              {refUrl}
            </Text>
          </Button>
        </div>
      )}
    </section>
  );
}
