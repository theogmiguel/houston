import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AnalyticsService } from "../telemetry/AnalyticsService.ts";

// Houston has no telemetry service: events are accepted and dropped, so callers keep
// upstream's calls and nothing reaches an ingest endpoint or writes an install id.
export const layer = Layer.succeed(AnalyticsService, {
  record: Effect.fn("HoustonAnalytics.record")(function* () {}),
  flush: Effect.void,
  recordOwners: Effect.fn("HoustonAnalytics.recordOwners")(function* () {}),
});
