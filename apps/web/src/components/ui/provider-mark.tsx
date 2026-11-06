import type { CSSProperties } from "react";

import {
  normalizeProviderAccentColor,
  providerInstanceInitials,
} from "@houston-app/client-runtime/state/provider-instance-display";
import type { ProviderDriverKind } from "@houston-app/contracts";

import { cn } from "~/lib/utils";
import { ProviderInstanceIcon, providerHasBrandGlyph } from "../chat/ProviderInstanceIcon";

/**
 * Tints for a provider without a brand glyph or an accent colour. A provider keeps one tint, picked
 * from its name, so two rows of the same provider never disagree.
 */
const MONOGRAM_TINTS = [
  "var(--info-foreground)",
  "var(--merged-foreground)",
  "var(--success-foreground)",
  "var(--accent-ink)",
] as const;

function tintFor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return MONOGRAM_TINTS[hash % MONOGRAM_TINTS.length]!;
}

/**
 * The 14px provider mark of a thread row: the brand glyph where the provider has one, otherwise a
 * rounded square carrying a two-letter monogram on the provider's tint.
 */
export function ProviderMark({
  driverKind,
  displayName,
  accentColor,
  acpRegistryAgentId,
  acpRegistryIconUrl,
  showBadge = false,
  className,
}: {
  driverKind: ProviderDriverKind;
  displayName: string;
  accentColor?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  /** Distinguishes several instances of one provider with a small initials badge. */
  showBadge?: boolean;
  className?: string;
}) {
  const hasGlyph = providerHasBrandGlyph({ driverKind, acpRegistryAgentId, acpRegistryIconUrl });
  if (hasGlyph) {
    return (
      <span
        role="img"
        aria-label={displayName}
        data-provider-mark=""
        data-provider-mark-kind="glyph"
        className={cn("inline-grid size-3.5 shrink-0 place-items-center", className)}
      >
        <ProviderInstanceIcon
          driverKind={driverKind}
          displayName={displayName}
          accentColor={accentColor}
          acpRegistryAgentId={acpRegistryAgentId}
          acpRegistryIconUrl={acpRegistryIconUrl}
          showBadge={showBadge}
          size="compact"
        />
      </span>
    );
  }
  const accent =
    normalizeProviderAccentColor(accentColor) ?? tintFor(`${driverKind}:${displayName}`);
  return (
    <span
      role="img"
      aria-label={displayName}
      data-provider-mark=""
      data-provider-mark-kind="monogram"
      style={{ "--provider-tint": accent } as CSSProperties}
      className={cn(
        "inline-grid size-3.5 shrink-0 place-items-center rounded-(--r-badge) bg-[color-mix(in_srgb,var(--provider-tint)_22%,transparent)] text-monogram font-semibold tracking-tight text-(--provider-tint)",
        className,
      )}
    >
      <span aria-hidden>{providerInstanceInitials(displayName)}</span>
    </span>
  );
}
