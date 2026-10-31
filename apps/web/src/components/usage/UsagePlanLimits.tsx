import type { EnvironmentId, UsageProviderKind } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  formatResetsIn,
  paceOf,
  remainingPercent,
  type LimitAccount,
} from "@t3tools/shared/usageLimits";
import { useAtomValue } from "@effect/atom-react";

import { environmentPresentations } from "../../state/presentation";
import { ensureLocalApi } from "../../localApi";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { providerClients } from "../settings/providerDriverMeta";
import { cn } from "../../lib/utils";
import { limitPresentationsFor } from "./UsageLimits";
import { usageRemainingFill, usageRemainingTone } from "./usageRemaining";

const PACE_TEXT = { ahead: "ahead of pace", on: "on pace", under: "under pace" } as const;

function accountLabel(account: LimitAccount): string {
  return (
    account.displayName ??
    account.email ??
    providerClients.get(account.driver)?.label ??
    String(account.driver)
  );
}

export function UsagePlanLimits({
  selectedEnvironmentIds,
  hiddenProviders,
  now,
}: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly now: number;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const accounts = collectLimitAccounts(
    limitPresentationsFor(presentations, selectedEnvironmentIds, hiddenProviders),
  );
  if (accounts.length === 0) {
    return (
      <section className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-5">
        <h2 className="text-[13px] leading-[18px] font-semibold text-[var(--t1)]">Plan limits</h2>
        <p className="text-xs text-[var(--t3)]">
          No provider on the selected environments reports subscription limits.
        </p>
      </section>
    );
  }

  const byDriver = new Map<LimitAccount["driver"], LimitAccount[]>();
  for (const account of accounts) {
    const list = byDriver.get(account.driver);
    if (list) list.push(account);
    else byDriver.set(account.driver, [account]);
  }
  const freshest = accounts.reduce<string | null>((latest, account) => {
    const checkedAt = account.limits.checkedAt;
    if (!checkedAt || !Number.isFinite(Date.parse(checkedAt))) return latest;
    return latest === null || Date.parse(checkedAt) > Date.parse(latest) ? checkedAt : latest;
  }, null);
  const updated = freshest ? formatRelativeTimeLabel(freshest, now) : null;

  return (
    <section className="rounded-[10px] border border-border bg-card p-5">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[13px] leading-[18px] font-semibold text-[var(--t1)]">Plan limits</h2>
        <span className="ml-auto text-xs text-[var(--t3)]">
          Current windows · ignores the period above
          {updated ? ` · updated ${updated}` : ""}
        </span>
      </div>
      {[...byDriver].map(([driver, driverAccounts]) => {
        const label = providerClients.get(driver)?.label ?? String(driver);
        const plan = driverAccounts.find((account) => account.plan)?.plan;
        const external = driverAccounts.find(
          (account) => account.limits.externalUsage?.url,
        )?.limits.externalUsage;
        return (
          <div
            key={driver}
            className="mt-3.5 grid gap-0.5 first:mt-3"
            role="group"
            aria-label={`${label} plan limits`}
          >
            <div className="flex h-7 items-center gap-2">
              <span
                aria-hidden
                className="inline-grid size-5 shrink-0 place-items-center rounded-[5px] border border-border"
              >
                <ProviderInstanceIcon
                  driverKind={driver}
                  displayName={label}
                  className="size-3"
                  iconClassName="size-3"
                />
              </span>
              <span className="text-[13px] font-medium text-[var(--t1)]">{label}</span>
              {plan ? <span className="text-xs text-[var(--t3)]">{plan}</span> : null}
              {external ? (
                <Button
                  className="ml-auto text-[var(--t1)]"
                  size="sm"
                  variant="ghost"
                  onClick={() => void ensureLocalApi()?.shell.openExternal(external.url)}
                >
                  Manage usage
                </Button>
              ) : null}
            </div>
            {driverAccounts.flatMap((account) =>
              account.limits.windows.map((window) => {
                const remaining = remainingPercent(window);
                const pace = paceOf(window, now);
                const resets = formatResetsIn(window, now);
                const low = usageRemainingTone(remaining) === "low";
                return (
                  <div
                    key={`${account.key}:${window.id}`}
                    className="grid grid-cols-[120px_minmax(0,1fr)_44px_220px] items-center gap-x-3.5"
                    style={{ height: 30 }}
                  >
                    <span className="truncate text-xs text-[var(--t2)]">
                      {window.label}
                      {driverAccounts.length > 1 ? ` · ${accountLabel(account)}` : ""}
                    </span>
                    <span className="block h-1 w-full overflow-hidden rounded-full bg-border">
                      <span
                        className="block h-full rounded-full"
                        style={{ width: `${remaining}%`, backgroundColor: usageRemainingFill(remaining) }}
                      />
                    </span>
                    <span
                      className={cn(
                        "text-right text-xs tabular-nums",
                        low ? "font-semibold text-[var(--t1)]" : "font-medium text-[var(--t2)]",
                      )}
                    >
                      {remaining}%
                    </span>
                    <span className="truncate text-xs text-[var(--t3)]">
                      {resets ? resets.replace(/^resets in /, "Resets in ") : ""}
                      {resets && pace ? " · " : ""}
                      {pace ? PACE_TEXT[pace] : ""}
                    </span>
                  </div>
                );
              }),
            )}
          </div>
        );
      })}
      <p className="mt-3 text-xs text-[var(--t3)]">
        Bars show room left. They stay neutral; below 20% the number turns full contrast, and an
        empty bar turns red when the provider stops.
      </p>
    </section>
  );
}
