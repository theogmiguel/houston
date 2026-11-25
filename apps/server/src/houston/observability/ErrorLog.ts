// The server's error log. Its attributes pass the export allowlist first, so it never holds more
// about a failure than an export may.
import * as SharedErrorLog from "@houston-app/shared/errorLog";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../../config.ts";
import { applyCredentialRules, credentialRules } from "../redact.ts";
import { isGeneratedId } from "./ErrorLogIds.ts";
import { exportedRecord } from "./ExportRedaction.ts";

/** Records nothing outside the server's observability layer, so only the server writes the files. */
export const ErrorLog = Context.Reference<SharedErrorLog.ErrorLog>("houston/ErrorLog", {
  defaultValue: () => SharedErrorLog.noopErrorLog,
});

// Exported, yet unneeded to name a failure: statement text, a request's host and the name a user
// gave a provider instance.
const UNWRITTEN_KEYS: ReadonlySet<string> = new Set([
  "db.query.text",
  "http.route",
  "orchestration_v2.driver",
  "server.address",
  "server.port",
  "url.scheme",
]);
// Strings Houston's code or a closed schema supplies. Any other string must be a generated id.
const ENUM_KEYS: ReadonlySet<string> = new Set([
  "db.operation.name",
  "db.system.name",
  "effect.logLevel",
  "houston.client.kind",
  "houston.command.type",
  "houston.effect.type",
  "houston.error.tag",
  "houston.job.name",
  "houston.model",
  "houston.outcome",
  "houston.provider",
  "houston.run.status",
  "http.request.method",
  "orchestration_v2.command_type",
  "orchestration_v2.source_point_type",
  "rpc.aggregate",
  "rpc.method",
  "rpc.system",
  "rpc.system.name",
  "rpc.transport",
]);
const SECRETS = credentialRules("[redacted]");

const writtenAttributes = (
  recorded: Readonly<Record<string, unknown>>,
): SharedErrorLog.ErrorLogAttributes => {
  const kept: Record<string, unknown> = {};
  let omittedIds = 0;
  for (const [key, value] of Object.entries(exportedRecord(recorded))) {
    if (UNWRITTEN_KEYS.has(key)) continue;
    if (typeof value === "string") {
      if (ENUM_KEYS.has(key)) {
        if (applyCredentialRules(value, SECRETS) !== value) continue;
      } else if (!isGeneratedId(value)) {
        omittedIds += 1;
        continue;
      }
    }
    kept[key] = value;
  }
  return { kept, omittedIds };
};

export const make = Effect.gen(function* () {
  const { logsDir } = yield* ServerConfig.ServerConfig;
  return SharedErrorLog.makeErrorLog({
    directory: logsDir,
    process: "server",
    clock: yield* Clock.Clock,
    attributes: writtenAttributes,
  });
});
