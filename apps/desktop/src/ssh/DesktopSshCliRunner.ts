import type { RemoteHoustonRunnerOptions } from "@houston-app/ssh/tunnel";
import * as Option from "effect/Option";

export interface DesktopSshCliRunnerInput {
  readonly isDevelopment: boolean;
  readonly devRemoteHoustonServerEntryPath: Option.Option<string>;
  readonly serverVersion: string;
  readonly serverNodeEngineRange: string;
}

/**
 * The remote host runs the CLI release that matches the server package. The
 * desktop app has its own version, so it must not supply the archive version.
 */
export function resolveDesktopSshCliRunner(
  input: DesktopSshCliRunnerInput,
): RemoteHoustonRunnerOptions {
  const devRemoteEntryPath = Option.getOrUndefined(input.devRemoteHoustonServerEntryPath);
  if (input.isDevelopment && devRemoteEntryPath !== undefined) {
    return {
      nodeScriptPath: devRemoteEntryPath,
      nodeEngineRange: input.serverNodeEngineRange,
    };
  }
  return { archiveVersion: input.serverVersion };
}
