import { memo, type MouseEventHandler, type PointerEventHandler } from "react";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  Minimize2Icon,
  PlayIcon,
  SquareIcon,
} from "lucide-react";
import { CornerUpRight, ListPlus } from "lucide";
import { MorphIcon } from "~/components/MorphIcon";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { formatDuration } from "@houston-app/shared/orchestrationTiming";
import { tickTextContent } from "~/lib/tickTextContent";
import { cn, isMacPlatform } from "~/lib/utils";
import { useShortcutModifierState } from "../../shortcutModifierState";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  alternateComposerDispatchAction,
  resolveComposerDispatchMode,
  type ActiveTurnComposerAction,
} from "@houston-app/client-runtime/state/composer-dispatch";

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
  /** When the running turn started; the stop button rings and names the elapsed time. */
  runningStartedAt?: string | null;
  /** The running thread's status word, such as "Waiting" while it is blocked on the user. */
  runningStateLabel?: string | null;
  canInterrupt: boolean;
  followUpBehavior?: "queue" | "steer";
  canSteer?: boolean;
  alternateShortcutLabel?: string | null;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  /** Dictation is running; Send finishes it and submits once the transcript lands. */
  voiceInputActive?: boolean;
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
  onSubmitWithMode?: ((mode: ActiveTurnComposerAction) => void) | undefined;
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
    return "Submitting…";
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
  "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-(--send) px-3 font-medium text-(--send-ink) text-xs transition-colors hover:bg-(--send)/90 disabled:pointer-events-none disabled:opacity-64 max-phone:rounded-(--r-ctl) max-phone:disabled:bg-(--sel) max-phone:disabled:text-muted-foreground max-phone:disabled:opacity-100",
  boardFocusRing,
);

/** The two halves of a split pill: a label segment and a chevron segment that opens its menu. */
const splitPillLabelClassName = cn(messageActionPillClassName, "rounded-r-none pr-3 pl-3.5");
const splitPillChevronClassName = cn(
  messageActionPillClassName,
  "rounded-l-none border-(--send-ink)/25 border-l bg-(--send) px-2",
);

const messageActionGhostPillClassName = cn(
  "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full border border-(--line-strong) bg-transparent px-3 font-medium text-(--t2) text-xs transition-colors hover:bg-(--hover) disabled:pointer-events-none disabled:opacity-64 max-phone:rounded-(--r-ctl)",
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
              "flex h-5.5 shrink-0 cursor-pointer items-center gap-1 rounded-md bg-(--sel) px-1.75 font-medium text-(--t2) text-xs tabular-nums transition-colors hover:bg-(--hover) aria-pressed:text-(--t1) disabled:pointer-events-none disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:size-3 [&_svg]:text-(--houston)",
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
  runningStartedAt = null,
  runningStateLabel = null,
  canInterrupt,
  followUpBehavior = "steer",
  canSteer = true,
  alternateShortcutLabel = null,
  showPlanFollowUpPrompt,
  promptHasText,
  voiceInputActive = false,
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
  onSubmitWithMode,
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

  const running = runningStartedAt !== null;
  const runningWord = runningStateLabel ?? "Running";
  const runningStartedMs = runningStartedAt === null ? null : Date.parse(runningStartedAt);
  const renderStopGenerationButton = () => (
    <Tooltip key="interrupt">
      <TooltipTrigger
        render={
          <button
            type="button"
            data-composer-running={running ? "true" : undefined}
            className={cn(
              "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-(--sel) text-(--t1) transition-colors duration-150 hover:bg-(--hover) disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:size-3.5",
              boardFocusRing,
            )}
            {...pointerFocusProps}
            disabled={!canOperateThread}
            onClick={() => {
              if (canOperateThread) onInterrupt();
            }}
            aria-label={running ? `Stop generation · ${runningWord}` : "Stop generation"}
          />
        }
      >
        <SquareIcon aria-hidden="true" fill="currentColor" stroke="none" />
      </TooltipTrigger>
      <TooltipPopup>
        <div className="flex items-center gap-1.5">
          <span>{runningWord}</span>
          {running ? (
            <>
              <span aria-hidden>·</span>
              <span
                ref={tickTextContent(
                  (nowMs) => formatDuration(Math.max(1_000, nowMs - (runningStartedMs ?? nowMs))),
                  true,
                )}
              />
            </>
          ) : null}
        </div>
        <div>Esc to interrupt</div>
      </TooltipPopup>
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
              className={cn(
                messageActionGhostPillClassName,
                "w-7 px-0 max-phone:h-11 max-phone:w-11",
              )}
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
              className={cn(messageActionGhostPillClassName, "max-phone:h-11 max-phone:px-4")}
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
          className={cn(messageActionPillClassName, "max-phone:h-11 max-phone:px-4")}
          {...pointerFocusProps}
          disabled={
            !canOperateThread ||
            isEnvironmentUnavailable ||
            pendingAction.isResponding ||
            (!voiceInputActive &&
              (pendingAction.isLastQuestion
                ? !pendingAction.isComplete
                : !pendingAction.canAdvance))
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
          {isSendBusy ? "Sending…" : "Refine"}
        </button>
      );
    }

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <button
          type="submit"
          className={splitPillLabelClassName}
          {...pointerFocusProps}
          disabled={isSendBusy || isSendDisabled || isEnvironmentUnavailable}
        >
          {isSendBusy ? "Sending…" : "Implement"}
        </button>
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                className={splitPillChevronClassName}
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

  const isSendButtonDisabled =
    isSendBusy ||
    isSendDisabled ||
    isEnvironmentUnavailable ||
    (!hasSendableContent && !showResume);

  const showDispatchMenu =
    isRunning && hasSendableContent && !isEditingQueuedMessage && onSubmitWithMode !== undefined;

  const sendButton = showDispatchMenu ? (
    <button
      type="submit"
      className={splitPillLabelClassName}
      {...pointerFocusProps}
      onClick={onSubmitMessage}
      disabled={isSendButtonDisabled}
      aria-label={submitStatus ?? submitLabel}
    >
      {isQueuing ? "Queue" : "Steer"}
    </button>
  ) : (
    <button
      type={showResume ? "button" : "submit"}
      className={cn(
        "relative isolate flex size-8 items-center justify-center overflow-hidden rounded-full bg-(--accent) text-(--primary-foreground) transition-colors duration-(--motion-feedback) enabled:cursor-pointer enabled:hover:bg-(--accent-hover) disabled:pointer-events-none [&_svg]:size-4 [&_svg]:pointer-events-none",
        // Idle-disabled reads as inert (neutral fill, muted glyph at full opacity); a busy send
        // keeps the accent so the spinner still reads as work in progress.
        isSendBusy ? "disabled:opacity-60" : "disabled:bg-(--sel) disabled:text-(--houston)",
        boardFocusRing,
      )}
      {...pointerFocusProps}
      onClick={showResume ? onResume : onSubmitMessage}
      disabled={isSendButtonDisabled}
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
        <ArrowUpIcon aria-hidden="true" strokeWidth="1.8" />
      )}
    </button>
  );

  const submit = (
    <Tooltip key="submit">
      <TooltipTrigger
        render={
          <span className={cn("inline-flex", isSendButtonDisabled && "cursor-not-allowed")} />
        }
      >
        {sendButton}
      </TooltipTrigger>
      <TooltipPopup>{submitTooltip}</TooltipPopup>
    </Tooltip>
  );

  if (showDispatchMenu) {
    return (
      <div className="flex items-center" data-chat-composer-send-menu="true">
        {submit}
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                className={splitPillChevronClassName}
                aria-label="Send options"
                onMouseDown={
                  preserveComposerFocusOnPointerDown ? (event) => event.preventDefault() : undefined
                }
              />
            }
          >
            <ChevronDownIcon className="size-3.5" aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="end" side="top" {...composerFloatingLayerProps}>
            <MenuItem onClick={() => onSubmitWithMode("queue")}>
              Queue message
              {followUpBehavior === "queue" ? <CheckIcon className="ml-auto size-3.5" /> : null}
            </MenuItem>
            <MenuItem disabled={!canSteer} onClick={() => onSubmitWithMode("steer")}>
              Steer message
              {followUpBehavior === "steer" ? <CheckIcon className="ml-auto size-3.5" /> : null}
            </MenuItem>
            <MenuItem onClick={() => onSubmitWithMode("restart")}>Interrupt and send</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    );
  }
  return submit;
});
