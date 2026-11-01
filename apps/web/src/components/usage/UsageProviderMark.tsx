import type { UsageProviderKind } from "@t3tools/contracts";

import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { PROVIDER_PRESENTATION } from "./usageProviders";

export function ProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const presentation = PROVIDER_PRESENTATION[provider];
  return (
    <ProviderInstanceIcon
      driverKind={presentation.driverKind}
      displayName={presentation.label}
      iconClassName={className}
    />
  );
}
