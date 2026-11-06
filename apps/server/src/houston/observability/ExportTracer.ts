import type * as Exit from "effect/Exit";
import * as Tracer from "effect/Tracer";

import {
  endAttributes,
  exportedEventName,
  exportedAttributes,
  exportedExit,
  exportedRecord,
} from "./ExportRedaction.ts";

const exportedLinks = (links: ReadonlyArray<Tracer.SpanLink>): Array<Tracer.SpanLink> =>
  links.map((link) => ({ span: link.span, attributes: exportedRecord(link.attributes) }));

class ExportSpan implements Tracer.Span {
  readonly _tag = "Span";
  readonly name: string;
  readonly spanId: string;
  readonly traceId: string;
  readonly parent: Tracer.Span["parent"];
  readonly annotations: Tracer.Span["annotations"];
  readonly links: Tracer.Span["links"];
  readonly sampled: boolean;
  readonly kind: Tracer.SpanKind;
  private readonly delegate: Tracer.Span;

  constructor(delegate: Tracer.Span) {
    this.delegate = delegate;
    this.name = delegate.name;
    this.spanId = delegate.spanId;
    this.traceId = delegate.traceId;
    this.parent = delegate.parent;
    this.annotations = delegate.annotations;
    this.links = delegate.links;
    this.sampled = delegate.sampled;
    this.kind = delegate.kind;
  }

  get status(): Tracer.SpanStatus {
    return this.delegate.status;
  }

  get attributes(): ReadonlyMap<string, unknown> {
    return this.delegate.attributes;
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    for (const [key, value] of endAttributes(exit)) this.delegate.attribute(key, value);
    this.delegate.end(endTime, exportedExit(exit));
  }

  attribute(key: string, value: unknown): void {
    for (const [exportedKey, exportedValue] of exportedAttributes(key, value)) {
      this.delegate.attribute(exportedKey, exportedValue);
    }
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    this.delegate.event(
      exportedEventName(name, Object.keys(attributes ?? {})),
      startTime,
      exportedRecord(attributes),
    );
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.delegate.addLinks(exportedLinks(links));
  }
}

// Wraps the exporting tracer: attributes outside the allowlist are dropped, failures keep only
// their error tag, and every span ends with its outcome.
export const make = (delegate: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    span: (options) =>
      new ExportSpan(delegate.span({ ...options, links: exportedLinks(options.links) })),
    ...(delegate.context === undefined ? {} : { context: delegate.context }),
  });
