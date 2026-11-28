import {
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
} from "@houston-app/contracts";
import { type TimestampFormat } from "@houston-app/contracts/settings";
import { deadlineStore } from "@houston-app/client-runtime/clock";
import { limitRecoveryOwnsSnooze } from "@houston-app/client-runtime/state/thread-execution";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@houston-app/shared/usageLimits";
import { GaugeIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useDeadlinePassed } from "../../hooks/useDeadline";
import { OpenAI } from "../Icons";
import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { Button, InlineButton } from "../ui/button";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { copyAdminRequest } from "./ThreadErrorBanner";
import type { Translate } from "~/i18n/useT";

type RecoveryProps = {
  runId: RunId;
  errorCode: string | null;
  resetAt: string | null;
  stoppedAt: string;
  settled: boolean;
  requestPending: boolean;
  snoozedUntil: string | null;
  recovery: OrchestrationV2LimitRecovery | null;
  timestampFormat: TimestampFormat;
  /** Automatic starts waiting on this thread's limit, in queue order. */
  heldStarts?: number;
  /** At least one of those held starts outlived its expected release. */
  heldOverdue?: boolean;
  onStartHeld?: () => Promise<void> | void;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
  translate: Translate;
};

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const {
    runId,
    errorCode,
    resetAt,
    stoppedAt,
    settled,
    requestPending,
    recovery,
    snoozedUntil,
    timestampFormat,
    heldStarts = 0,
    heldOverdue = false,
    onStartHeld = () => {},
    translate: t,
  } = props;
  // The server refuses recovery changes while a request is pending.
  const canSchedule =
    !settled && !requestPending && resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  const resumes =
    canSchedule && recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  const workspaceLimit = errorCode === CHATGPT_WORKSPACE_USAGE_LIMIT_CODE;
  const chatGptLimit = workspaceLimit || errorCode === CHATGPT_USAGE_LIMIT_CODE;
  const recoveryActions = canSchedule ? (
    <RecoveryActions key={`${runId}:${resetAt}`} {...props} />
  ) : null;
  const displayAt =
    resumes && resetAt && snoozedUntil && Date.parse(snoozedUntil) > Date.parse(resetAt)
      ? snoozedUntil
      : resetAt;
  const resetDescription = displayAt
    ? resumes
      ? t("Resumes {time}", { time: formatUpcomingTimestamp(displayAt, timestampFormat) })
      : t("Resets {time}", { time: formatUpcomingTimestamp(displayAt, timestampFormat) })
    : t("Reset time unavailable; retry manually");
  if (!chatGptLimit) {
    const holdNote =
      heldStarts > 0
        ? heldStarts === 1
          ? heldOverdue
            ? t("1 automatic start waits (overdue)")
            : t("1 automatic start waits")
          : heldOverdue
            ? t("{count} automatic starts wait (overdue)", { count: heldStarts })
            : t("{count} automatic starts wait", { count: heldStarts })
        : null;
    return {
      id: `usage-limit-recovery:${runId}`,
      variant: "warning",
      group: "environment",
      icon: <GaugeIcon />,
      title: t("Usage limit reached"),
      description: holdNote === null ? resetDescription : `${resetDescription} · ${holdNote}`,
      actions:
        heldStarts > 0 ? (
          <>
            {recoveryActions}
            <StartHeldItemsAction onStartHeld={onStartHeld} translate={t} />
          </>
        ) : (
          recoveryActions
        ),
    };
  }
  // OpenAI's partner guidelines specify this ChatGPT notice and its actions.
  return {
    id: `usage-limit-recovery:${runId}`,
    variant: "warning",
    group: "environment",
    icon: <OpenAI aria-hidden="true" />,
    title: t("ChatGPT usage limit reached"),
    description: workspaceLimit
      ? "You've reached your workspace's limit for using your ChatGPT plan in other apps."
      : resetDescription,
    actions: (
      <>
        {recoveryActions}
        {workspaceLimit ? (
          <Button size="xs" variant="ghost" onClick={copyAdminRequest}>
            {t("Copy request for admin")}
          </Button>
        ) : (
          <ChatGptUsageButton size="xs" variant="ghost" />
        )}
      </>
    ),
  };
}

function StartHeldItemsAction({
  onStartHeld,
  translate: t,
}: {
  onStartHeld: () => Promise<void> | void;
  translate: Translate;
}) {
  const [pending, setPending] = useState(false);
  // A ref ignores a second click before the disabled render lands.
  const inFlight = useRef(false);
  async function start() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await onStartHeld();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: t("Could not start held items"),
        description: cause instanceof Error ? cause.message : t("An error occurred."),
      });
    }
    inFlight.current = false;
    setPending(false);
  }
  return (
    <InlineButton touchTarget="padded" disabled={pending} onClick={() => void start()}>
      {pending ? t("Starting…") : t("Start held items")}
    </InlineButton>
  );
}

function RecoveryActions({
  runId,
  resetAt,
  recovery,
  snoozedUntil,
  onChange,
  translate: t,
}: RecoveryProps) {
  const [pending, setPending] = useState(false);

  const scheduled =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  // The server leaves snoozedUntil in place after the timer wakes the thread,
  // so a snooze whose reset has passed is no longer active.
  const resetPassed = useDeadlinePassed(resetAt === null ? null : Date.parse(resetAt));
  const snoozed =
    limitRecoveryOwnsSnooze({ runId, resetAt, recovery, snoozedUntil }) && !resetPassed;
  async function toggle(action: "resume" | "snooze") {
    if (resetAt === null) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      toastManager.add({
        type: "error",
        title: t("Could not hold thread"),
        description: t("The reset time has passed. Retry the thread manually."),
      });
      // The deadline timer can lag after a throttled tab or sleep; disable now.
      deadlineStore(Date.parse(resetAt)).refresh();
      return;
    }
    setPending(true);
    try {
      await onChange({
        runId,
        resetAt,
        ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: action === "resume" ? t("Could not change auto-resume") : t("Could not hold thread"),
        description: cause instanceof Error ? cause.message : t("An error occurred."),
      });
    }
    setPending(false);
  }
  // Inline errors would widen the actions column and crush the title.
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
      <InlineButton touchTarget="padded" disabled={pending} onClick={() => void toggle("resume")}>
        {pending ? t("Saving...") : scheduled ? t("Cancel auto-resume") : t("Resume at reset")}
      </InlineButton>
      <InlineButton
        touchTarget="padded"
        disabled={pending || (!snoozed && resetPassed)}
        onClick={() => void toggle("snooze")}
      >
        {pending ? t("Saving...") : snoozed ? t("Bring back now") : t("Hold until reset")}
      </InlineButton>
    </span>
  );
}
