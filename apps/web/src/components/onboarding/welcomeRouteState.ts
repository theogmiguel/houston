import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeEnvironmentId = Schema.decodeOption(EnvironmentId);

/** TanStack Router strips the leading `#`, so the setup anchor is `setup`, not `#setup`. */
export function readWelcomeRouteState(hash: string): {
  readonly setupRequested: boolean;
  readonly resumeEnvironmentId: EnvironmentId | undefined;
} {
  const resumeEnvironmentId = hash.startsWith("agents:")
    ? Option.getOrUndefined(decodeEnvironmentId(hash.slice("agents:".length)))
    : undefined;
  return {
    setupRequested: resumeEnvironmentId !== undefined || hash === "setup",
    resumeEnvironmentId,
  };
}
