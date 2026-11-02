/// <reference types="vite-plus/client" />

import type { HostBridge, ThreadId } from "@houston-app/contracts";

interface ImportMetaEnv {
  readonly VITE_HTTP_URL: string;
  readonly VITE_WS_URL: string;
  readonly VITE_HOSTED_APP_URL: string;
  readonly VITE_HOSTED_APP_CHANNEL: string;
  readonly VITE_RELEASE_CHANNEL: string;
  readonly HOUSTON_DESKTOP_UPDATE_REPOSITORY: string;
  readonly HOUSTON_FEATURE_SECRETS: string;
  readonly APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    hostBridge?: HostBridge;
    /** Dev builds only, from DevReplayHost. Agents call these from the browser console. */
    t3dev?: {
      readonly replayScenarios: () => ReadonlyArray<string>;
      readonly replay: (scenario?: string) => Promise<ThreadId>;
    };
  }
}
