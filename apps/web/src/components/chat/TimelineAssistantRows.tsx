import { shouldPreserveAssistantLineBreaks } from "@houston-app/shared/markdownPipeline";
import { type RunId } from "@houston-app/contracts";
import { canForkProjectedAssistantItem } from "@houston-app/client-runtime/state/thread-workflows";
import { useAtomValue } from "@effect/atom-react";
import { memo, use, useState } from "react";
import { type ChatMessage, type TurnDiffSummary } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import { GitForkIcon } from "lucide-react";
import { Button } from "../ui/button";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { McpAppFrame } from "./McpAppFrame";
import { checkpointFileTotals } from "@houston-app/client-runtime/state/thread-checkpoints";
import { TimelineChangesRow } from "./TimelineChangesRow";
import { useFileContextMenuHandler } from "../../fileContextMenu";
import { useAssistantMessageText, useProject, useThreadShell } from "../../state/entities";
import { CopyButton } from "../ui/copy-button";
import { AssistantCitationSource } from "./AssistantCitationSource";
import { resolveAssistantMessageCopyState } from "./MessagesTimeline.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Text } from "../ui/text";
import { cn } from "~/lib/utils";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { useV2ItemSupport } from "../../state/v2ItemSupport";
import { serverEnvironment } from "../../state/server";
import { resolveAssistantModelAttribution } from "./assistantModelAttribution";
import { AssistantModelAttributionLine } from "./AssistantModelAttributionLine";
import { TimelineRowCtx, TimelineRowActivityCtx, type TimelineRow } from "./timelineRowContext";
import { MESSAGE_HEADING_LEVEL, MessageAuthorHeading } from "./TimelineRowParts";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { MessagesSquareIcon } from "lucide-react";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { SecondOpinionReviewCard } from "./SecondOpinionReviewCard";

/**
 * The hover footer closes a turn. Its 6px lead, 24px buttons less the 8px they hang below it,
 * and the 2px row padding add up to the 24px between turns (`pb-0` on the row in
 * `MessagesTimeline`), so the gap does not depend on whether the footer is showing.
 */
const ASSISTANT_TURN_FOOTER_CLASS_NAME = "mt-1.5 -mb-2 h-6";

export function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  // The timeline holds a streaming message's row while only its text grows.
  const liveText = useAssistantMessageText(
    row.message.streaming ? ctx.threadRef : null,
    row.projectedItem?.item.id,
  );
  const text = liveText ?? row.message.text;
  const messageText = text || (row.message.streaming ? "" : "(empty response)");

  return (
    <>
      <div className="relative min-w-0 px-1 py-0.5">
        <MessageAuthorHeading>Houston</MessageAuthorHeading>
        <div data-thread-find-text="true">
          <AssistantCitationSource
            messageId={row.message.id}
            {...(ctx.threadRef ? { threadRef: ctx.threadRef } : {})}
            itemKey={row.id}
            request={ctx.citationRequest}
            listRef={ctx.listRef}
          >
            <ChatMarkdown
              text={messageText}
              cwd={ctx.markdownCwd}
              threadRef={ctx.threadRef ?? undefined}
              isStreaming={Boolean(row.message.streaming)}
              lineBreaks={shouldPreserveAssistantLineBreaks(messageText)}
              skills={ctx.skills}
              headingLevelOffset={MESSAGE_HEADING_LEVEL}
              onUseArtifactTemplate={ctx.onUseArtifactTemplate}
              onRunShellCommand={ctx.onRunShellCommand}
              onImageExpand={ctx.onImageExpand}
            />
          </AssistantCitationSource>
        </div>
        {row.showAssistantMeta && row.message.runId ? (
          <AssistantModelAttributionRow
            runId={row.message.runId}
            previousRunId={row.previousAnswerRunId ?? null}
          />
        ) : null}
        {ctx.onOpenTurnDiff ? (
          <AssistantChangedFilesSection
            turnSummary={row.assistantTurnDiffSummary}
            onOpenTurnDiff={ctx.onOpenTurnDiff}
          />
        ) : null}
        {row.showAssistantMeta ? (
          <AssistantMessageMeta
            className={ASSISTANT_TURN_FOOTER_CLASS_NAME}
            projectedItem={row.projectedItem}
            message={row.message}
            showCopyButton={row.showAssistantCopyButton}
            copyStreaming={row.assistantCopyStreaming}
            modelRunId={row.message.runId ?? null}
            alwaysVisible={row.assistantMetaAlwaysVisible === true}
          />
        ) : null}
        <SecondOpinionCardForRun runId={row.message.runId} />
      </div>
    </>
  );
}

/** The read-only review card for the turn the run produced, when one exists. */
function SecondOpinionCardForRun({ runId }: { readonly runId: RunId | null | undefined }) {
  const ctx = use(TimelineRowCtx);
  const review =
    runId === null || runId === undefined ? undefined : ctx.secondOpinion?.reviews.get(runId);
  if (review === undefined) return null;
  return (
    <div className="pb-8">
      <SecondOpinionReviewCard threadRef={review} />
    </div>
  );
}

/** Asks another provider for a read-only review of this turn. */
function AssistantSecondOpinionButton({
  projectedItem,
}: {
  readonly projectedItem: NonNullable<Extract<TimelineRow, { kind: "message" }>["projectedItem"]>;
}) {
  const ctx = use(TimelineRowCtx);
  const opinion = ctx.secondOpinion;
  const runId = projectedItem.item.runId;
  if (opinion === undefined || runId === null || projectedItem.item.type !== "assistant_message") {
    return null;
  }
  const reviewedInstanceId = ctx.runs.find((run) => run.id === runId)?.providerInstanceId;
  const reviewedDriver = opinion.entries.find(
    (entry) => entry.instanceId === reviewedInstanceId,
  )?.driverKind;
  const entries = opinion.entries.filter(
    (entry) => entry.enabled && entry.driverKind !== reviewedDriver && entry.models.length > 0,
  );
  if (entries.length === 0) return null;

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  aria-label="Request a second opinion"
                >
                  <MessagesSquareIcon className="size-3" />
                </Button>
              }
            />
          }
        />
        <TooltipPopup side="top">Second opinion</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="top">
        {entries.map((entry) => (
          <MenuSub key={entry.instanceId}>
            <MenuSubTrigger>
              <ProviderInstanceIcon
                driverKind={entry.driverKind}
                displayName={entry.displayName}
                accentColor={entry.accentColor}
                className="size-4"
                iconClassName="size-3.5"
              />
              <span className="min-w-0 flex-1 truncate">{entry.displayName}</span>
            </MenuSubTrigger>
            <MenuSubPopup>
              {entry.models.map((model) => (
                <MenuItem
                  key={model.slug}
                  onClick={() =>
                    void opinion.onRequest({
                      sourceThreadId: projectedItem.sourceThreadId,
                      runId,
                      instanceId: entry.instanceId,
                      model: model.slug,
                    })
                  }
                >
                  {model.name}
                </MenuItem>
              ))}
            </MenuSubPopup>
          </MenuSub>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/**
 * Subscribes to the answer's run: attribution needs the model it ran on, which imported or
 * run-less messages do not carry. It is visible only when the model differs from the previous
 * answer's; every answer names its model on hover or focus, beside the timestamp.
 */
function AssistantModelAttributionRow({
  runId,
  previousRunId,
}: {
  runId: RunId | null | undefined;
  previousRunId: RunId | null;
}) {
  const ctx = use(TimelineRowCtx);
  const providers = useAtomValue(
    serverEnvironment.providersValueAtom(ctx.activeThreadEnvironmentId),
  );
  if (previousRunId === null) return null;
  const attribution = resolveAssistantModelAttribution({ runs: ctx.runs, runId, providers });
  const previous = resolveAssistantModelAttribution({
    runs: ctx.runs,
    runId: previousRunId,
    providers,
  });
  if (
    attribution !== null &&
    previous !== null &&
    previous.providerDisplayName === attribution.providerDisplayName &&
    previous.modelLabel === attribution.modelLabel
  ) {
    return null;
  }
  return <AssistantModelAttributionLine attribution={attribution} />;
}

function AssistantForkButton({
  projectedItem,
}: {
  readonly projectedItem: NonNullable<Extract<TimelineRow, { kind: "message" }>["projectedItem"]>;
}) {
  const ctx = use(TimelineRowCtx);
  const [busy, setBusy] = useState(false);
  const support = useV2ItemSupport({
    environmentId: ctx.activeThreadEnvironmentId,
    sourceThreadId: projectedItem.sourceThreadId,
    sourceItemId: projectedItem.sourceItemId,
  });
  const canFork = canForkProjectedAssistantItem({
    projectedItem,
    capabilities: support.providerSession?.capabilities,
  });

  const onForkFromRun = ctx.onForkFromRun;
  if (!canFork || onForkFromRun === undefined || projectedItem.item.runId === null) return null;
  const runId = projectedItem.item.runId;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onForkFromRun({ sourceThreadId: projectedItem.sourceThreadId, runId }).finally(
                () => setBusy(false),
              );
            }}
            aria-label="Fork from this response"
          />
        }
      >
        <GitForkIcon className={cn("size-3", busy && "animate-pulse")} />
      </TooltipTrigger>
      <TooltipPopup side="top">Fork from this response</TooltipPopup>
    </Tooltip>
  );
}

export function AssistantMetaTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "assistant-meta" }>;
}) {
  return (
    <div className="px-1">
      <AssistantMessageMeta
        className="mt-0.5"
        projectedItem={row.projectedItem}
        message={row.message}
        showCopyButton={row.showAssistantCopyButton}
        copyStreaming={row.assistantCopyStreaming}
        alwaysVisible={row.alwaysVisible === true}
      />
    </div>
  );
}

function AssistantMessageMeta({
  className,
  projectedItem,
  message,
  showCopyButton,
  copyStreaming,
  alwaysVisible = false,
  modelRunId = null,
}: {
  className?: string;
  projectedItem?: Extract<TimelineRow, { kind: "message" }>["projectedItem"];
  message: ChatMessage;
  showCopyButton: boolean;
  copyStreaming: boolean;
  alwaysVisible?: boolean;
  /** The run whose model the hover line names; the line is absent when it is unknown. */
  modelRunId?: RunId | null;
}) {
  const ctx = use(TimelineRowCtx);
  const providers = useAtomValue(
    serverEnvironment.providersValueAtom(ctx.activeThreadEnvironmentId),
  );
  const attribution = resolveAssistantModelAttribution({
    runs: ctx.runs,
    runId: modelRunId,
    providers,
  });

  return (
    <div
      className={cn(
        "flex items-center gap-2 text-xs tabular-nums transition-opacity duration-200",
        alwaysVisible
          ? "opacity-100"
          : "opacity-0 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/assistant:opacity-100",
        className,
      )}
    >
      {projectedItem && projectedItem.item.status !== "completed" ? (
        <span className="rounded-full border border-border/70 px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
          {projectedItem.item.status}
        </span>
      ) : null}
      <AssistantCopyButton
        message={message}
        showCopyButton={showCopyButton}
        streaming={copyStreaming}
      />
      {projectedItem?.item.type === "assistant_message" ? (
        <AssistantForkButton projectedItem={projectedItem} />
      ) : null}
      {projectedItem?.item.type === "assistant_message" ? (
        <AssistantSecondOpinionButton projectedItem={projectedItem} />
      ) : null}
      {attribution !== null && !message.streaming ? (
        <Text as="span" variant="callout" tone="muted" data-assistant-model-hover="true">
          {attribution.providerDisplayName} · {attribution.modelLabel}
        </Text>
      ) : null}
      {!message.streaming && (
        <Tooltip>
          <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
            {formatDayAwareTimestamp(message.updatedAt, ctx.timestampFormat)}
          </TooltipTrigger>
          <TooltipPopup>
            {formatChatTimestampTooltip(message.updatedAt, ctx.timestampFormat)}
          </TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}

function AssistantCopyButton({
  message,
  showCopyButton,
  streaming,
}: {
  message: ChatMessage;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: message.text ?? null,
    showCopyButton,
    streaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return (
    <CopyButton
      label="Copy message"
      size="xs"
      value={assistantCopyState.text ?? ""}
      variant="ghost-muted"
    />
  );
}

export function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        planMarkdown={row.proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        threadRef={ctx.threadRef ?? undefined}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
        findActive={ctx.findActive}
      />
    </div>
  );
}

export function HtmlRenderTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "html-render" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const { onAppFullscreenChange } = ctx;
  const onFullscreenChange = (fullscreen: boolean) => onAppFullscreenChange(row.id, fullscreen);

  if (ctx.renderHtmlRender) {
    return <div className="min-w-0 px-1">{ctx.renderHtmlRender(row)}</div>;
  }
  return (
    <div className="min-w-0 px-1">
      <HtmlRenderFrame
        key={row.htmlRender.attachmentId}
        environmentId={ctx.activeThreadEnvironmentId}
        htmlRender={row.htmlRender}
        threadRef={ctx.threadRef ?? undefined}
        onFullscreenChange={onFullscreenChange}
      />
    </div>
  );
}

export function McpAppTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "mcp-app" }> }) {
  const ctx = use(TimelineRowCtx);
  const { awaitingUser } = use(TimelineRowActivityCtx);

  return (
    <div className="min-w-0 px-1">
      <McpAppFrame
        key={row.mcpApp.attachmentId}
        environmentId={ctx.activeThreadEnvironmentId}
        threadId={row.sourceThreadId}
        conversationThreadId={ctx.threadRef?.threadId ?? row.sourceThreadId}
        itemId={row.itemId}
        revision={row.revision}
        app={row.mcpApp}
        onSendMessage={ctx.onSendAppMessage}
        awaitingUser={awaitingUser}
        onFullscreenChange={(fullscreen) => ctx.onAppFullscreenChange(row.id, fullscreen)}
      />
    </div>
  );
}

/** Subscribes directly to the UI state store for expand/collapse state,
 *  so toggling re-renders only this component — not the entire list. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  displayThreadKey?: string;
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
}) {
  const ctx = use(TimelineRowCtx);
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;
  // The composer's pending-changes row already summarises this run; one summary per turn.
  if (ctx.changeBannerRunId === turnSummary.runId) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  displayThreadKey?: string;
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
}) {
  const ctx = use(TimelineRowCtx);
  const thread = useThreadShell(ctx.threadRef);
  const activeProject = useProject(
    thread && thread.projectId
      ? { environmentId: thread.environmentId, projectId: thread.projectId }
      : null,
  );
  const onFileContextMenu = useFileContextMenuHandler(ctx.activeThreadEnvironmentId);
  const totals = checkpointFileTotals(turnSummary);

  return (
    <div className="mt-3">
      <TimelineChangesRow
        files={checkpointFiles}
        totals={totals}
        workspaceRoot={ctx.workspaceRoot}
        onOpenDiff={() => onOpenTurnDiff(turnSummary.runId, checkpointFiles[0]?.path)}
        onOpenFile={(filePath) => onOpenTurnDiff(turnSummary.runId, filePath)}
        onFileContextMenu={(filePath, event) =>
          onFileContextMenu(
            {
              environmentId: ctx.activeThreadEnvironmentId,
              filePath,
              workspaceRoot: ctx.workspaceRoot,
              repositoryRoot:
                thread?.worktreePath == null
                  ? activeProject?.repositoryIdentity?.rootPath
                  : undefined,
            },
            event,
          )
        }
      />
    </div>
  );
}
