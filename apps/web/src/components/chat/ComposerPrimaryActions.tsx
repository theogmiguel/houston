import { memo, type MouseEventHandler, type PointerEventHandler } from "react";
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, Minimize2Icon, PlayIcon } from "lucide-react";
import { CornerUpRight, ListPlus } from "lucide";
import { MorphIcon } from "~/components/MorphIcon";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { cn, isMacPlatform } from "~/lib/utils";
import { useShortcutModifierState } from "../../shortcutModifierState";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  alternateComposerDispatchAction,
  resolveComposerDispatchMode,
} from "@t3tools/client-runtime/state/composer-dispatch";

interface PendingActionState {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
}

interface ComposerPrimaryActionsProps {
  compact: boolean;
  canOperateThread: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  canInterrupt: boolean;
  followUpBehavior?: "queue" | "steer";
  canSteer?: boolean;
  alternateShortcutLabel?: string | null;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isEnvironmentUnavailable: boolean;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  canResume?: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  isEditingQueuedMessage?: boolean;
  onSubmitMessage?: MouseEventHandler<HTMLButtonElement>;
  onResume?: () => void;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
  compactBeforeSendTokens?: number | null;
  keepFullHistory?: boolean;
  onToggleKeepFullHistory?: () => void;
}

const formatPendingPrimaryActionLabel = (input: {
  compact: boolean;
  isLastQuestion: boolean;
  isResponding: boolean;
  questionIndex: number;
}) => {
  if (input.isResponding) {
    return "Submitting...";
  }
  if (input.compact) {
    return input.isLastQuestion ? "Submit" : "Next";
  }
  if (!input.isLastQuestion) {
    return "Next question";
  }
  return input.questionIndex > 0 ? "Submit answers" : "Submit answer";
};

const boardFocusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

const messageActionPillClassName = cn(
  "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-(--t1) px-3 font-medium text-(--pane) text-xs transition-colors hover:bg-(--t1)/90 disabled:pointer-events-none disabled:opacity-64",
  boardFocusRing,
);

const messageActionGhostPillClassName = cn(
  "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-(--line-strong) bg-transparent px-3 font-medium text-(--t2) text-xs transition-colors hover:bg-(--hover) disabled:pointer-events-none disabled:opacity-64",
  boardFocusRing,
);

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

export function ComposerCompactBeforeSendChip({
  tokens,
  keepFullHistory,
  onToggleKeepFullHistory,
  disabled,
  preserveComposerFocusOnPointerDown = false,
}: {
  tokens: number;
  keepFullHistory: boolean;
  onToggleKeepFullHistory: () => void;
  disabled: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
}) {
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;
  const compactTokens = formatContextWindowTokens(tokens);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-chat-composer-compact-send="true"
            className={cn(
              "flex h-5.5 shrink-0 cursor-pointer items-center gap-1 rounded-md bg-(--sel) px-1.75 font-medium text-(--t2) text-xs tabular-nums transition-colors hover:bg-(--hover) aria-pressed:text-(--t1) disabled:pointer-events-none disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:size-3 [&_svg]:text-(--t3)",
              boardFocusRing,
            )}
            {...pointerFocusProps}
            aria-pressed={!keepFullHistory}
            aria-label={`Compact ${compactTokens} tokens of history before sending`}
            disabled={disabled}
            onClick={onToggleKeepFullHistory}
          />
        }
      >
        <Minimize2Icon aria-hidden="true" />
        {keepFullHistory ? "Keep" : "Compact"}
        <span className="text-muted-foreground">{compactTokens}</span>
      </TooltipTrigger>
      <TooltipPopup>
        <div>
          {keepFullHistory
            ? `Next send keeps all ${compactTokens} tokens.`
            : `Next send compacts ${compactTokens} tokens first.`}
        </div>
        <div>{keepFullHistory ? "Click to compact first" : "Click to keep full history"}</div>
      </TooltipPopup>
    </Tooltip>
  );
}

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  canOperateThread,
  pendingAction,
  isRunning,
  canInterrupt,
  followUpBehavior = "steer",
  canSteer = true,
  alternateShortcutLabel = null,
  showPlanFollowUpPrompt,
  promptHasText,
  isSendBusy,
  sendDisabledReason,
  isEnvironmentUnavailable,
  isPreparingWorktree,
  hasSendableContent,
  canResume = false,
  preserveComposerFocusOnPointerDown = false,
  isEditingQueuedMessage = false,
  onSubmitMessage,
  onResume,
  onPreviousPendingQuestion,
  onInterrupt,
  onImplementPlanInNewThread,
  compactBeforeSendTokens = null,
  keepFullHistory = false,
}: ComposerPrimaryActionsProps) {
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;
  const shortcutModifiers = useShortcutModifierState();
  const isQueuing =
    !isEditingQueuedMessage &&
    resolveComposerDispatchMode({
      running: isRunning,
      activeTurnDefault: followUpBehavior,
      canSteer,
      alternateModifier: shortcutModifiers.metaKey || shortcutModifiers.ctrlKey,
    }) === "queue";
  const alternateAction = alternateComposerDispatchAction(followUpBehavior);
  const isSendDisabled = !canOperateThread || sendDisabledReason !== null;

  const renderStopGenerationButton = () => (
    <Tooltip key="interrupt">
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-(--t1) text-(--pane) transition-colors duration-150 hover:bg-(--t1)/90 disabled:pointer-events-none disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:size-3.5",
              boardFocusRing,
            )}
            {...pointerFocusProps}
            disabled={!canOperateThread}
            onClick={() => {
              if (canOperateThread) onInterrupt();
            }}
            aria-label="Stop generation"
          />
        }
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      </TooltipTrigger>
      <TooltipPopup>Interrupt</TooltipPopup>
    </Tooltip>
  );

  if (pendingAction) {
    return (
      <div className="flex items-center justify-end gap-0.5">
        {canInterrupt ? renderStopGenerationButton() : null}
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <button
              type="button"
              className={cn(messageActionGhostPillClassName, "w-7 px-0")}
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label="Previous question"
            >
              <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className={messageActionGhostPillClassName}
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
            >
              Previous
            </button>
          )
        ) : null}
        <button
          type="submit"
          className={messageActionPillClassName}
          {...pointerFocusProps}
          disabled={
            !canOperateThread ||
            isEnvironmentUnavailable ||
            pendingAction.isResponding ||
            (pendingAction.isLastQuestion ? !pendingAction.isComplete : !pendingAction.canAdvance)
          }
        >
          {formatPendingPrimaryActionLabel({
            compact,
            isLastQuestion: pendingAction.isLastQuestion,
            isResponding: pendingAction.isResponding,
            questionIndex: pendingAction.questionIndex,
          })}
        </button>
      </div>
    );
  }

  if (showPlanFollowUpPrompt && (promptHasText || !canResume)) {
    if (promptHasText) {
      return (
        <button
          type="submit"
          className={messageActionPillClassName}
          {...pointerFocusProps}
          disabled={isSendBusy || isSendDisabled || isEnvironmentUnavailable}
        >
          {isSendBusy ? "Sending..." : "Refine"}
        </button>
      );
    }

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <button
          type="submit"
          className={cn(messageActionPillClassName, "rounded-r-none pr-3 pl-3.5")}
          {...pointerFocusProps}
          disabled={isSendBusy || isSendDisabled || isEnvironmentUnavailable}
        >
          {isSendBusy ? "Sending..." : "Implement"}
        </button>
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                className={cn(
                  messageActionPillClassName,
                  "rounded-l-none border-(--pane)/25 border-l bg-(--t1) px-2",
                )}
                aria-label="Implementation actions"
                onMouseDown={
                  preserveComposerFocusOnPointerDown ? (event) => event.preventDefault() : undefined
                }
                disabled={isSendBusy || isSendDisabled || isEnvironmentUnavailable}
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top" {...composerFloatingLayerProps}>
            <MenuItem
              disabled={isSendBusy || isSendDisabled || isEnvironmentUnavailable}
              onClick={() => {
                if (canOperateThread) onImplementPlanInNewThread();
              }}
            >
              Implement in a new thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  if (canInterrupt && !hasSendableContent && !isEditingQueuedMessage) {
    return renderStopGenerationButton();
  }

  const showResume = canResume && !hasSendableContent && !isEditingQueuedMessage;

  const compactTokens =
    compactBeforeSendTokens !== null && !showResume && !isEditingQueuedMessage
      ? formatContextWindowTokens(compactBeforeSendTokens)
      : null;
  const compactsBeforeSend = compactTokens !== null && !keepFullHistory;

  const submitLabel = showResume
    ? "Resume thread"
    : isEditingQueuedMessage
      ? "Update queued message"
      : compactsBeforeSend
        ? "Compact and send"
        : isQueuing
          ? "Queue message"
          : isRunning
            ? "Steer message"
            : "Submit message";
  const submitStatus = isEnvironmentUnavailable
    ? "Environment disconnected"
    : (sendDisabledReason ??
      (isPreparingWorktree
        ? "Preparing worktree"
        : isSendBusy
          ? isEditingQueuedMessage
            ? "Updating queued message"
            : "Submitting message"
          : null));
  const submitTooltip =
    submitStatus ??
    (compactsBeforeSend
      ? `Summarize ${compactTokens} tokens of history, then send`
      : isRunning && !isEditingQueuedMessage && canSteer
        ? `Click to ${followUpBehavior}, ${isMacPlatform(navigator.platform) ? "⌘" : "Ctrl"}-click${alternateShortcutLabel ? ` or ${alternateShortcutLabel}` : ""} to ${alternateAction}`
        : submitLabel);

  const sendButton = (
    <button
      type={showResume ? "button" : "submit"}
      className={cn(
        "relative isolate flex size-7 items-center justify-center overflow-hidden rounded-full transition-colors duration-150 enabled:cursor-pointer disabled:pointer-events-none [&_svg]:size-3.5 [&_svg]:pointer-events-none",
        boardFocusRing,
        hasSendableContent
          ? "bg-(--t1) text-(--pane) enabled:hover:bg-(--t1)/90 disabled:bg-(--sel) disabled:text-(--t3)"
          : "bg-(--sel) text-(--t3)",
      )}
      {...pointerFocusProps}
      onClick={showResume ? onResume : onSubmitMessage}
      disabled={
        isSendBusy ||
        isSendDisabled ||
        isEnvironmentUnavailable ||
        (!hasSendableContent && !showResume)
      }
      aria-label={submitStatus ?? submitLabel}
    >
      {isSendBusy ? (
        <Spinner size="sm" aria-hidden="true" />
      ) : showResume ? (
        <PlayIcon className="size-4 fill-current" aria-hidden="true" />
      ) : isEditingQueuedMessage ? (
        <CheckIcon className="size-4" aria-hidden="true" />
      ) : isRunning ? (
        <MorphIcon className="size-4" icon={isQueuing ? ListPlus : CornerUpRight} />
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );

  const submit = (
    <Tooltip key="submit">
      <TooltipTrigger render={<span className="inline-flex" />}>{sendButton}</TooltipTrigger>
      <TooltipPopup>{submitTooltip}</TooltipPopup>
    </Tooltip>
  );
  return submit;
});
