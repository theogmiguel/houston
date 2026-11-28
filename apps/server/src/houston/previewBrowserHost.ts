import * as HostProcess from "@houston-app/shared/HostProcess";
import * as Effect from "effect/Effect";

import { resolveRootCliCommand } from "../cli/invocation.ts";
import * as PreviewBrowserHost from "../preview/PreviewBrowserHost.ts";

/**
 * Settings > Browser asks the server that runs the browser whether its host
 * blocks Chrome's sandbox. The command comes from the same install resolution
 * as the browser pane so both surfaces name the exact command to run.
 */
export const hostSetup = Effect.gen(function* () {
  const env = yield* HostProcess.Environment;
  const blocked =
    !PreviewBrowserHost.sandboxDisabled(env) && (yield* PreviewBrowserHost.sandboxBlocked);
  if (!blocked) return { blocked: false, setupCommand: "" };
  return {
    blocked: true,
    setupCommand: yield* resolveRootCliCommand(PreviewBrowserHost.SETUP_SUBCOMMAND),
  };
}).pipe(Effect.withSpan("HoustonPreviewBrowserHost.hostSetup"));
