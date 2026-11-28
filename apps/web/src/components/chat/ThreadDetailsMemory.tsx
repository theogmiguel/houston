import type { EnvironmentId, ThreadId } from "@houston-app/contracts";
import type { ReactNode } from "react";

import { useThreadMemory } from "../../state/threadMemory";
import { useT } from "~/i18n/useT";
import { TooltipLine } from "../ui/tooltip";

const GIGABYTE = 1024 ** 3;
const TRAILING_ZERO = /\.0$/;

/** "30 GB", "16.2 GB" and "5.4 GB" keep one decimal only while it says something. */
function formatMemoryGigabytes(bytes: number): string {
  const gigabytes = bytes / GIGABYTE;
  const digits = gigabytes >= 100 ? 0 : 1;
  return `${gigabytes.toFixed(digits).replace(TRAILING_ZERO, "")} GB`;
}

interface ThreadMemoryRow {
  readonly label: string;
  readonly left: number | null;
  readonly value: string | undefined;
  readonly tooltip: ReactNode;
}

/** The machine's memory left, with the thread's share when the server can attribute it. */
export function useThreadMemoryRow(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ThreadMemoryRow {
  const t = useT();
  const { data, error } = useThreadMemory(environmentId, threadId);
  const machine = data?.machine ?? null;
  const thread = data?.thread ?? null;
  const pending = data === null && error === null;

  return {
    label: t("Memory"),
    left: machine?.leftPercent ?? null,
    value: pending ? "…" : machine === null ? t("Unavailable") : undefined,
    tooltip: (
      <>
        {machine !== null ? (
          <TooltipLine>
            {t("{label}: {percent}% left", { label: t("Memory"), percent: machine.leftPercent })}
          </TooltipLine>
        ) : pending ? (
          <TooltipLine tone="muted">{t("Reading memory…")}</TooltipLine>
        ) : (
          <TooltipLine>{t("Memory is unavailable")}</TooltipLine>
        )}
        {machine !== null ? (
          <TooltipLine tone="muted">
            {t("{used} of {total} used", {
              used: formatMemoryGigabytes(machine.usedBytes),
              total: formatMemoryGigabytes(machine.totalBytes),
            })}
          </TooltipLine>
        ) : null}
        {thread !== null ? (
          <TooltipLine tone="muted">
            {thread.subagentCount > 0
              ? t("This thread {size} · {count} sub-agents", {
                  size: formatMemoryGigabytes(thread.residentBytes),
                  count: thread.subagentCount,
                })
              : t("This thread {size}", {
                  size: formatMemoryGigabytes(thread.residentBytes),
                })}
          </TooltipLine>
        ) : null}
      </>
    ),
  };
}
