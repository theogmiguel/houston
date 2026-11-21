import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "@houston-app/contracts";
import {
  collectProviderUsageLimits,
  formatDuration,
  type LimitPace,
  limitsNotice,
  paceOf,
  remainingPercent,
} from "@houston-app/shared/usageLimits";
import { CalendarIcon, GaugeIcon, TimerIcon } from "lucide-react";
import type { ReactNode } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { usageRemainingTone } from "../usage/usageRemaining";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { useT } from "~/i18n/useT";

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: "Ahead of pace",
  on: "On pace",
  under: "Under pace",
};

const LONG_SPAN = /week|month|day/i;
const SHORT_SPAN = /session|hour|minute/i;

/** A limit window's glyph, from the span its label names; other windows read as a gauge. */
function UsageGlyph({ label }: { readonly label: string }) {
  const className = "size-4 shrink-0";
  if (LONG_SPAN.test(label)) return <CalendarIcon aria-hidden className={className} />;
  if (SHORT_SPAN.test(label)) return <TimerIcon aria-hidden className={className} />;
  return <GaugeIcon aria-hidden className={className} />;
}

export interface ThreadDetailsUsageInput {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
  readonly contextWindow: ContextWindowSnapshot | null;
}

/**
 * The selected provider's limit windows and the thread's context window.
 * Every row reads as room left, so a longer bar always means more headroom.
 */
export function ThreadDetailsUsage({
  providerInstanceId,
  providers,
  sources,
  contextWindow,
}: ThreadDetailsUsageInput) {
  const t = useT();
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const report =
    providerInstanceId !== null
      ? collectProviderUsageLimits(providerInstanceId, providers, sources, now)
      : null;
  // Only this instance's data: the report keeps one instance per login, and any other entry may be
  // a different login or workspace, so fall back to the instance's own snapshot.
  const limits =
    report?.accounts.find((entry) => entry.instanceId === providerInstanceId)?.limits ??
    providers.find((provider) => provider.instanceId === providerInstanceId)?.usageLimits;
  const notice = limits ? limitsNotice(limits) : null;
  if (!limits && !contextWindow) return null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title={t("Usage")}
      showHeading={false}
    >
      <div className="grid grid-cols-[minmax(0,auto)_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {notice ? (
          <UsageRow
            label={t("Limits")}
            left={null}
            value={t("Unavailable")}
            tooltip={<span className="text-foreground">{notice}</span>}
          />
        ) : null}
        {limits && !notice
          ? limits.windows.map((window) => <LimitRow key={window.id} window={window} now={now} />)
          : null}
        {contextWindow ? <ContextRow usage={contextWindow} spaced={limits !== undefined} /> : null}
      </div>
    </ThreadDetailsSection>
  );
}

function LimitRow({
  window,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const t = useT();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = remainingPercent(window);
  const pace = paceOf(window, now);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return (
    <UsageRow
      label={window.label}
      left={left}
      tooltip={
        <>
          <span className="text-foreground">
            {t("{label}: {percent}% left", { label: window.label, percent: left })}
          </span>
          {window.resetsAt && resetsAt > now ? (
            <span className="text-muted-foreground">
              {t("Resets in {duration} · {time}", {
                duration: formatDuration(resetsAt - now),
                time: formatUpcomingTimestamp(window.resetsAt, timestampFormat, now),
              })}
            </span>
          ) : null}
          {pace ? <span className="text-muted-foreground">{t(PACE_LABEL[pace])}</span> : null}
        </>
      }
    />
  );
}

function ContextRow({
  usage,
  spaced,
}: {
  readonly usage: ContextWindowSnapshot;
  readonly spaced: boolean;
}) {
  const t = useT();
  const maxTokens = usage.maxTokens ?? null;
  const left =
    maxTokens !== null && usage.usedPercentage !== null
      ? Math.round(100 - Math.max(0, Math.min(100, usage.usedPercentage)))
      : null;
  const used = formatContextWindowTokens(usage.usedTokens);
  return (
    <UsageRow
      label={t("Context")}
      left={left}
      className={cn(spaced && "mt-1")}
      tooltip={
        <>
          {left !== null ? (
            <span className="text-foreground">
              {t("Context: {percent}% left", { percent: left })}
            </span>
          ) : null}
          <span className={left !== null ? "text-muted-foreground" : "text-foreground"}>
            {maxTokens !== null
              ? t("{used} of {total} tokens used", {
                  used,
                  total: formatContextWindowTokens(maxTokens),
                })
              : t("{used} tokens used", { used })}
          </span>
        </>
      }
      value={left === null ? used : undefined}
    />
  );
}

/** One label, hairline, and value row; the whole row opens the details tooltip. */
function UsageRow({
  label,
  left,
  tooltip,
  value,
  className,
}: {
  readonly label: string;
  readonly left: number | null;
  readonly tooltip: ReactNode;
  /** Replaces the percentage when there is none. */
  readonly value?: string | undefined;
  readonly className?: string | undefined;
}) {
  const t = useT();
  const tone = left === null ? null : usageRemainingTone(left);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            tabIndex={0}
            aria-label={
              value !== undefined
                ? t("{label}: {value}", { label, value })
                : left !== null
                  ? t("{label}: {percent}% left", { label, percent: left })
                  : label
            }
            className={cn(
              "col-span-3 grid min-h-7 max-phone:min-h-11 max-phone:px-4 cursor-default grid-cols-subgrid items-center rounded-md px-2 py-0.5 outline-none hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-[var(--hover)]",
              className,
            )}
          />
        }
      >
        <span className="flex min-w-0 max-w-32 items-center gap-1.5 text-muted-foreground">
          <UsageGlyph label={label} />
          <span className="truncate">{label}</span>
        </span>
        {left !== null ? (
          <span className="relative h-1 rounded-full bg-muted-foreground/25">
            {left > 0 ? (
              <span
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full",
                  tone === "empty" ? "bg-error" : "bg-muted-foreground",
                )}
                style={{ width: `max(${left}%, 6px)` }}
              />
            ) : null}
          </span>
        ) : null}
        <span
          className={cn(
            // Text-only rows span the bar column so they never widen the shared value column.
            "text-end tabular-nums",
            left === null && "col-span-2",
            tone === "low" || tone === "empty"
              ? "font-emphasis text-foreground"
              : "font-medium text-muted-foreground",
          )}
        >
          {value ?? `${left}%`}
        </span>
      </TooltipTrigger>
      {/* Rows sit 8px inside the card; clear its edge instead of overlapping it. */}
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5">{tooltip}</div>
      </TooltipPopup>
    </Tooltip>
  );
}
