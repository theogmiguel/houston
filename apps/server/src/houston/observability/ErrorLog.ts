// The server's error log. Its attributes pass the export allowlist first, so it never holds more
// about a failure than an export may.
import * as SharedErrorLog from "@houston-app/shared/errorLog";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../../config.ts";
import { applyCredentialRules, credentialRules } from "../redact.ts";
import { exportedRecord } from "./ExportRedaction.ts";

/** Records nothing outside the server's observability layer, so only the server writes the files. */
export const ErrorLog = Context.Reference<SharedErrorLog.ErrorLog>("houston/ErrorLog", {
  defaultValue: () => SharedErrorLog.noopErrorLog,
});

// Exported, yet unneeded to name a failure: statement text and a request's host.
const UNWRITTEN_KEYS: ReadonlySet<string> = new Set([
  "db.query.text",
  "http.route",
  "server.address",
  "server.port",
  "url.scheme",
]);
const SECRETS = credentialRules("[redacted]");

const isWritten = (key: string, value: unknown) =>
  !UNWRITTEN_KEYS.has(key) &&
  (typeof value !== "string" || applyCredentialRules(value, SECRETS) === value);

const writtenAttributes = (recorded: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(exportedRecord(recorded)).filter(([key, value]) => isWritten(key, value)),
  );

export const make = Effect.gen(function* () {
  const { logsDir } = yield* ServerConfig.ServerConfig;
  return SharedErrorLog.makeErrorLog({
    directory: logsDir,
    process: "server",
    clock: yield* Clock.Clock,
    attributes: writtenAttributes,
  });
});
