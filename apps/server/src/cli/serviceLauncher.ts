import * as Effect from "effect/Effect";
import { Command } from "effect/cli";

import { main as runServiceLauncher } from "../serviceLauncher.ts";

export async function runServiceLauncherCli(): Promise<void> {
  try {
    await runServiceLauncher();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`[service-launcher] ${message}\n`);
    process.exitCode = 1;
  }
}

/** The launcher must stop its child before exiting; `runMain` would interrupt that shutdown. */
export const serviceLauncherCommand = Command.make("__service-launcher").pipe(
  Command.unlisted,
  Command.withHandler(() => Effect.sync(() => void runServiceLauncherCli())),
);
