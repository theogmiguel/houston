import type { EnvironmentId, UsageLimitsReport } from "@houston-app/contracts";
import type { TimestampFormat } from "@houston-app/contracts/settings";
import { limitsNotice } from "@houston-app/shared/usageLimits";
import { GaugeIcon } from "lucide-react";

import { ensureLocalApi } from "../../localApi";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { LimitWindows, ResetCredits } from "../usage/UsageLimits";
import { ComposerBanner } from "./ComposerBanner";
import { useT } from "~/i18n/useT";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import type { Translate } from "~/i18n/useT";

function accountLabel(account: UsageLimitsReport["accounts"][number]): string {
  if (!account.instanceId) return account.label;
  const driver = providerClients.get(account.driver)?.label ?? String(account.driver);
  const instance =
    account.displayName?.trim() ||
    (String(account.instanceId) !== String(account.driver) ? account.instanceId : "");
  return instance && instance.toLowerCase() !== driver.toLowerCase()
    ? `${driver} · ${instance}`
    : driver;
}

function AccountSummary({ account }: { readonly account: UsageLimitsReport["accounts"][number] }) {
  const t = useT();
  const label = accountLabel(account);
  return (
    <>
      {label.includes("@") ? (
        <RedactedSensitiveText
          key={label}
          value={label}
          ariaLabel={t("Toggle account label visibility")}
          revealTooltip={t("Click to reveal account")}
          hideTooltip={t("Click to hide account")}
          className="max-w-full truncate align-bottom font-sans text-xs leading-normal"
        />
      ) : (
        label
      )}
      {account.plan ? ` · ${account.plan}` : null}
    </>
  );
}

export function usageLimitsBannerItem(
  id: string,
  report: UsageLimitsReport,
  environmentId: EnvironmentId,
  onDismiss: () => void,
  t: Translate,
): ComposerBannerStackItem {
  const [first] = report.accounts;
  const single = report.accounts.length === 1 && first ? first : null;
  const summary = single ? (
    <AccountSummary account={single} />
  ) : (
    `${report.accounts.length} accounts`
  );
  return {
    id,
    variant: "info",
    icon: <GaugeIcon />,
    title: t("Usage limits"),
    description: summary,
    dismissLabel: t("Dismiss usage limits"),
    onDismiss,
    children: <UsageLimitsBannerBody report={report} environmentId={environmentId} />,
  };
}

export function modelFallbackBannerItem({
  fallbackModelName,
  defaultProviderName,
  defaultModelName,
  resetsAt,
  timestampFormat,
  onUseDefault,
  onDismiss,
  translate: t,
}: {
  readonly fallbackModelName: string;
  readonly defaultProviderName: string;
  readonly defaultModelName: string;
  readonly resetsAt: string | null;
  readonly timestampFormat: TimestampFormat;
  readonly onUseDefault: () => void;
  readonly onDismiss: () => void;
  readonly translate: Translate;
}): ComposerBannerStackItem {
  return {
    id: "fallback-model",
    variant: "info",
    icon: <GaugeIcon />,
    title: t("Using {model}", { model: fallbackModelName }),
    description: resetsAt
      ? t("{provider} is out of usage · resets {time}", {
          provider: defaultProviderName,
          time: formatUpcomingTimestamp(resetsAt, timestampFormat),
        })
      : t("{provider} is out of usage", { provider: defaultProviderName }),
    actions: (
      <Button size="xs" variant="ghost" onClick={onUseDefault}>
        {t("Use {model}", { model: defaultModelName })}
      </Button>
    ),
    dismissLabel: t("Dismiss fallback model notice"),
    onDismiss,
  };
}

function UsageLimitsBannerBody({
  report,
  environmentId,
}: {
  readonly report: UsageLimitsReport;
  readonly environmentId: EnvironmentId;
}) {
  const now = Date.parse(report.createdAt);
  return (
    <ComposerBanner.Scroll>
      <ComposerBanner.Body className="flex flex-col gap-2 pt-1 pb-1.5 pe-2">
        {report.accounts.map((account) => {
          const resetCreditInput =
            account.resetCreditInput ??
            (account.instanceId ? { instanceId: account.instanceId } : undefined);
          const notice = limitsNotice(account.limits);
          const externalUsage = account.limits.externalUsage;
          return (
            <div key={account.id} className="flex min-w-0 flex-col gap-1">
              {report.accounts.length > 1 ? (
                <span className="truncate text-xs text-muted-foreground">
                  <AccountSummary account={account} />
                </span>
              ) : null}
              {notice ? (
                <span className="text-xs text-muted-foreground">{notice}</span>
              ) : (
                <LimitWindows compact windows={account.limits.windows} now={now} />
              )}
              {externalUsage ? (
                <Button
                  size="sm"
                  variant="link"
                  className="self-start"
                  onClick={() => void ensureLocalApi().shell.openExternal(externalUsage.url)}
                >
                  Manage usage
                </Button>
              ) : null}
              {resetCreditInput && account.limits.resetCredits ? (
                <ResetCredits
                  environmentId={environmentId}
                  input={resetCreditInput}
                  credits={account.limits.resetCredits}
                  now={now}
                />
              ) : null}
            </div>
          );
        })}
        {report.notices.map((notice) => (
          <span key={notice} className="text-xs text-muted-foreground">
            {notice}
          </span>
        ))}
      </ComposerBanner.Body>
    </ComposerBanner.Scroll>
  );
}
