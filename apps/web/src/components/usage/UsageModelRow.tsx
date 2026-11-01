import { isModelCostUnknown, type ModelTotals } from "@t3tools/shared/usageMerge";
import { formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";

import { cn } from "~/lib/utils";
import { ProviderMark } from "./UsageProviderMark";
import { modelShare } from "./usageBreakdown";
import { PROVIDER_PRESENTATION } from "./usageProviders";

export function UsageModelRow({
  model,
  metric,
  loading,
  onSelectModel,
}: {
  readonly model: ModelTotals;
  readonly metric: "cost" | "tokens";
  readonly loading: boolean;
  readonly onSelectModel: (key: string) => void;
}) {
  const key = `${model.provider}:${model.model}`;
  const share = modelShare(model, metric);
  const rowFigures = cn("transition-opacity", loading && "opacity-40 delay-150");
  return (
    <tr className="relative h-[38px] border-t border-border text-right whitespace-nowrap tabular-nums transition-colors hover:bg-[var(--hover)]">
      <td className="px-4 text-left whitespace-normal">
        <button
          type="button"
          onClick={() => onSelectModel(key)}
          className="inline-flex items-center gap-2.5 text-left text-[var(--t1)] outline-none after:absolute after:inset-0"
        >
          <span
            aria-hidden
            className="inline-grid size-5 shrink-0 place-items-center rounded-[5px] border border-border"
          >
            <ProviderMark provider={model.provider} className="size-3" />
          </span>
          <span className="font-mono">{model.model}</span>
        </button>
      </td>
      <td className={cn("px-4 text-[var(--t3)]", rowFigures)}>{formatTokens(model.totalTokens)}</td>
      <td className={cn("px-4 text-[var(--t1)]", rowFigures)}>
        {isModelCostUnknown(model) ? (
          <span className="text-[var(--t3)]">Unpriced</span>
        ) : (
          formatUsd(model.costUsd)
        )}
      </td>
      <td className="px-4">
        <span className="flex items-center gap-2">
          <span className="block h-1 flex-1 overflow-hidden rounded-full bg-border">
            <span
              className="block h-full rounded-full"
              style={{
                width: `${Math.min(100, Math.max(0, (share ?? 0) * 100))}%`,
                backgroundColor: PROVIDER_PRESENTATION[model.provider].color,
              }}
            />
          </span>
          <span className={cn("w-11 text-right text-xs text-[var(--t3)]", rowFigures)}>
            {share === null ? "" : formatPercent(share)}
          </span>
        </span>
      </td>
    </tr>
  );
}
