import type { CSSProperties } from "react";

import {
  normalizeProviderAccentColor,
  providerInstanceInitials,
} from "@houston-app/client-runtime/state/provider-instance-display";
import type { ProviderDriverKind } from "@houston-app/contracts";

import { cn } from "~/lib/utils";
import { ProviderInstanceIcon, providerHasBrandGlyph } from "../chat/ProviderInstanceIcon";

/**
 * The provider mark of a thread row: the brand glyph where the provider has one, otherwise a 16px
 * rounded tile carrying an 11px/600 two-letter monogram. The monogram is neutral (muted letters on a
 * muted fill), so it never reads as a status colour; only an accent the provider's owner chose
 * tints it.
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
  const accent = normalizeProviderAccentColor(accentColor);
  return (
    <span
      role="img"
      aria-label={displayName}
      data-provider-mark=""
      data-provider-mark-kind="monogram"
      style={accent === undefined ? undefined : ({ "--provider-tint": accent } as CSSProperties)}
      className={cn(
        "inline-grid size-4 shrink-0 place-items-center rounded-(--r-badge) text-monogram font-semibold tracking-tight",
        accent === undefined
          ? "bg-(--sel) text-secondary-label"
          : "bg-[color-mix(in_srgb,var(--provider-tint)_22%,transparent)] text-(--provider-tint)",
        className,
      )}
    >
      <span aria-hidden>{providerInstanceInitials(displayName)}</span>
    </span>
  );
}
