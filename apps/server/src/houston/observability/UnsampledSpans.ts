import * as Tracer from "effect/Tracer";

// Spans with these names start unsampled; their children inherit it, so none of them is recorded
// or exported.
export const make = (tracer: Tracer.Tracer, names: ReadonlySet<string>): Tracer.Tracer =>
  Tracer.make({
    span: (options) =>
      tracer.span(names.has(options.name) ? { ...options, sampled: false } : options),
    ...(tracer.context === undefined ? {} : { context: tracer.context }),
  });
