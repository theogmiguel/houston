import type { ProviderInstanceId, ServerProvider } from "@houston-app/contracts";
import type { Dispatch, SetStateAction } from "react";
import { ProviderStatusBanner } from "./ProviderStatusBanner";

/**
 * The provider banner pinned above the timeline. A thread failure is a card in the composer
 * slot instead, so it never covers the timeline.
 */
export function ChatBannerLane(props: {
  providerStatus: ServerProvider | null;
  providerStatusBannerKey: string | null;
  setDismissedProviderStatusBannerKey: Dispatch<SetStateAction<string | null>>;
  onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
}) {
  const {
    providerStatus,
    providerStatusBannerKey,
    setDismissedProviderStatusBannerKey,
    onOpenProviderSetup,
  } = props;
  return (
    <div className="chat-banner-lane pointer-events-none absolute top-0 z-30 flex flex-col">
      <ProviderStatusBanner
        status={providerStatus}
        onDismiss={() => setDismissedProviderStatusBannerKey(providerStatusBannerKey)}
        onOpenProviderSetup={onOpenProviderSetup}
      />
    </div>
  );
}
