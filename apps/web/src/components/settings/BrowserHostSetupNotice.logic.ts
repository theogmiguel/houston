import { previewStreamHostSetupMessage } from "@houston-app/client-runtime/preview/server-browser-stream";
import type { HoustonPreviewBrowserHost } from "@houston-app/contracts";

export interface BrowserHostSetupBanner {
  readonly message: string;
  readonly command: string;
}

/** The banner's copy, from the same host-setup message the browser pane uses. */
export function browserHostSetupBanner(
  status: HoustonPreviewBrowserHost | null,
): BrowserHostSetupBanner | null {
  if (status === null || !status.blocked) return null;
  return {
    message: previewStreamHostSetupMessage({ need: "sandbox", command: status.setupCommand }),
    command: status.setupCommand,
  };
}
