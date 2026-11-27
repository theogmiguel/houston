import type { EnvironmentId } from "@houston-app/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect } from "react";

import { useT } from "../../i18n/useT";
import { useEnvironmentQuery } from "../../state/query";
import { previewEnvironment } from "../../state/preview";
import { CommandBlock } from "../CommandBlock";
import { Alert, AlertDescription } from "../ui/alert";
import { browserHostSetupBanner } from "./BrowserHostSetupNotice.logic";

/**
 * The one-time host setup for Chrome's sandbox, shown where the user looks for
 * browser settings rather than only when a tab or an agent's preview needs it.
 */
export function BrowserHostSetupNotice({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const t = useT();
  const query = useEnvironmentQuery(
    environmentId === null ? null : previewEnvironment.hostSetup({ environmentId, input: {} }),
  );
  const refresh = query.refresh;
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- a window focus listener held while mounted, so the host check refreshes after the user ran the setup elsewhere
  useEffect(() => {
    if (environmentId === null) return;
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [environmentId, refresh]);

  const banner = browserHostSetupBanner(query.data);
  if (banner === null) return null;
  return (
    <Alert variant="warning" role="note">
      <TriangleAlertIcon aria-hidden />
      <AlertDescription>
        <p>{banner.message}</p>
        <CommandBlock command={banner.command} />
        <p>
          {t("Run this once on the host machine. An agent cannot run it because it needs sudo.")}
        </p>
      </AlertDescription>
    </Alert>
  );
}
