import type { UsageProviderKind } from "@houston-app/contracts";
import { isModelCostUnknown, type ModelTotals } from "@houston-app/shared/usageMerge";
import { formatPercent, formatTokens, formatUsd } from "@houston-app/shared/usageFormat";

import { ProviderMark } from "../components/usage/UsageProviderMark";
import { modelShare } from "../components/usage/usageBreakdown";
import { PROVIDER_PRESENTATION } from "../components/usage/usageProviders";
import {
  USAGE_MODEL_CARD_CLS,
  USAGE_MODEL_CARD_COST_CLS,
  USAGE_MODEL_CARD_FIGURES_CLS,
  USAGE_MODEL_CARD_FILL_CLS,
  USAGE_MODEL_CARD_HEADLINE_CLS,
  USAGE_MODEL_CARD_LIST_CLS,
  USAGE_MODEL_CARD_LOADING_CLS,
  USAGE_MODEL_CARD_MARK_CLS,
  USAGE_MODEL_CARD_NAME_CLS,
  USAGE_MODEL_CARD_PERCENT_CLS,
  USAGE_MODEL_CARD_SETTLED_CLS,
  USAGE_MODEL_CARD_SHARE_CLS,
  USAGE_MODEL_CARD_TRACK_CLS,
} from "../components/ui/usage-model-recipes";
import { cn } from "../lib/utils";

const figuresClass = (loading: boolean) =>
  loading ? USAGE_MODEL_CARD_LOADING_CLS : USAGE_MODEL_CARD_SETTLED_CLS;

/** The desktop model table becomes one card per model on a phone. */
export function UsageModelCards({
  models,
  metric,
  loadingProviders,
  onSelectModel,
}: {
  readonly models: ReadonlyArray<ModelTotals>;
  readonly metric: "cost" | "tokens";
  readonly loadingProviders: ReadonlySet<UsageProviderKind>;
  readonly onSelectModel: (key: string) => void;
}) {
  return (
    <ul className={USAGE_MODEL_CARD_LIST_CLS} aria-label="Usage by model">
      {models.map((model) => {
        const key = `${model.provider}:${model.model}`;
        const share = modelShare(model, metric);
        const loading = loadingProviders.has(model.provider);
        return (
          <li key={key}>
            <button
              type="button"
              onClick={() => onSelectModel(key)}
              className={USAGE_MODEL_CARD_CLS}
            >
              <span className={USAGE_MODEL_CARD_HEADLINE_CLS}>
                <span aria-hidden className={USAGE_MODEL_CARD_MARK_CLS}>
                  <ProviderMark provider={model.provider} className="size-3" />
                </span>
                <span className={USAGE_MODEL_CARD_NAME_CLS}>{model.model}</span>
                <span className={cn(USAGE_MODEL_CARD_COST_CLS, figuresClass(loading))}>
                  {isModelCostUnknown(model) ? "Unpriced" : formatUsd(model.costUsd)}
                </span>
              </span>
              <span className={USAGE_MODEL_CARD_FIGURES_CLS}>
                <span className={figuresClass(loading)}>
                  {formatTokens(model.totalTokens)} tokens
                </span>
                <span className={USAGE_MODEL_CARD_SHARE_CLS}>
                  <span aria-hidden className={USAGE_MODEL_CARD_TRACK_CLS}>
                    <span
                      className={USAGE_MODEL_CARD_FILL_CLS}
                      style={{
                        width: `${Math.min(100, Math.max(0, (share ?? 0) * 100))}%`,
                        backgroundColor: PROVIDER_PRESENTATION[model.provider].color,
                      }}
                    />
                  </span>
                  <span className={cn(USAGE_MODEL_CARD_PERCENT_CLS, figuresClass(loading))}>
                    {share === null ? "" : formatPercent(share)}
                  </span>
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
