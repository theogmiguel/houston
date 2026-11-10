import type * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

import { LOG_EVENT_NAME, exportedCause, exportedRecord } from "./ExportRedaction.ts";

// OTLP log records read annotations from the fiber, so the exporter sees a fiber whose
// annotations are already filtered.
const withExportedAnnotations = (fiber: Fiber.Fiber<unknown, unknown>) =>
  Object.create(fiber, {
    getRef: {
      value: <A>(reference: Parameters<typeof fiber.getRef<A>>[0]): A => {
        const value = fiber.getRef(reference);
        return reference === References.CurrentLogAnnotations
          ? (exportedRecord(value as Record<string, unknown>) as A)
          : value;
      },
    },
  }) as Fiber.Fiber<unknown, unknown>;

/** A logger that exports a record's level, span context, allowlisted annotations and error tag, not its message. */
export const redacting = <Output>(logger: Logger.Logger<unknown, Output>) =>
  Logger.make<unknown, Output>((options) =>
    logger.log({
      ...options,
      message: LOG_EVENT_NAME,
      cause: exportedCause(options.cause),
      fiber: withExportedAnnotations(options.fiber),
    }),
  );
