import * as Schema from "effect/Schema";
import { TrimmedString } from "../baseSchemas.ts";

/** One shell the server found on this machine, offered for the terminal setting. */
export const TerminalShellCandidate = Schema.Struct({
  shell: TrimmedString,
  label: TrimmedString,
});
export type TerminalShellCandidate = typeof TerminalShellCandidate.Type;

/**
 * The machine's shells and the one a terminal starts when the setting is empty.
 * `defaultShell` is a command or path the spawner already accepts.
 */
export const TerminalShells = Schema.Struct({
  defaultShell: TrimmedString,
  candidates: Schema.Array(TerminalShellCandidate),
});
export type TerminalShells = typeof TerminalShells.Type;
