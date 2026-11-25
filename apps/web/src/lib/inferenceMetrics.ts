import type { InferenceThreadLastRequest } from "@houston-app/contracts/houston/inference";
import { formatPercent, formatTokens } from "@houston-app/shared/usageFormat";

/** Shown for a measurement the gateway did not record; an en dash, as product copy avoids em dashes. */
export const MISSING_MEASUREMENT = "–";

export function formatMeasuredSeconds(ms: number | null): string {
  if (ms === null) return MISSING_MEASUREMENT;
  const seconds = ms / 1000;
  const digits = seconds < 0.1 ? 2 : seconds < 10 ? 1 : 0;
  return `${seconds.toFixed(digits)} s`;
}

export function formatTokensPerSecond(rate: number | null): string {
  if (rate === null) return MISSING_MEASUREMENT;
  return `${rate.toFixed(rate < 10 ? 1 : 0)} tok/s`;
}

/** The cached part of a prompt, or null when it cannot be known. */
export function cachedPromptShare(
  promptTokens: number | null,
  cachedPromptTokens: number | null,
): number | null {
  if (promptTokens === null || cachedPromptTokens === null || promptTokens <= 0) return null;
  return Math.min(1, cachedPromptTokens / promptTokens);
}

export function formatCachedShare(share: number | null): string {
  return share === null ? MISSING_MEASUREMENT : formatPercent(share, 0);
}

/** "Last request: 12.3K prompt tokens (80% cached) · TTFT 1.2 s · 35 tok/s · waited 0.4 s" */
export function formatLastInferenceRequest(last: InferenceThreadLastRequest): string {
  const prompt = last.promptTokens === null ? MISSING_MEASUREMENT : formatTokens(last.promptTokens);
  const cached = formatCachedShare(cachedPromptShare(last.promptTokens, last.cachedPromptTokens));
  return [
    `Last request: ${prompt} prompt tokens (${cached} cached)`,
    `TTFT ${formatMeasuredSeconds(last.ttftMs)}`,
    formatTokensPerSecond(last.decodeTokensPerSecond),
    `waited ${formatMeasuredSeconds(last.queueWaitMs)}`,
  ].join(" · ");
}
