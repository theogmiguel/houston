import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

import {
  endAttributes,
  exportedEventName,
  exportedAttributes,
  exportedExit,
  exportedRecord,
} from "./ExportRedaction.ts";

// SQLite client spans: statements and the SQL client's transaction controls. Houston's SQLite
// layer sets no `db.namespace`, so the client names its control spans by operation alone.
const SQLITE_SPAN_NAMES: ReadonlySet<string> = new Set([
  "sqlite",
  "sql.transaction",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE SAVEPOINT",
  "ROLLBACK TO SAVEPOINT",
]);
// Statements take tens to hundreds of microseconds; 5 ms is over ten times the slowest common one
// (COMMIT), so only contention and disk stalls get through. Raising it exports fewer spans.
const SLOW_SQLITE_SPAN_NS = 5_000_000n;

const exportedLinks = (links: ReadonlyArray<Tracer.SpanLink>): Array<Tracer.SpanLink> =>
  links.map((link) => ({ span: link.span, attributes: exportedRecord(link.attributes) }));

// SQLite spans are exported only when slow, failed, or an ancestor of an exported span, so a
// receiver never shows an exported span whose parent was dropped. The local file keeps them all.
class SqliteSpans {
  // Live SQLite spans by span id; a span leaves when it ends.
  private readonly live = new Map<string, ExportSpan>();

  register(span: ExportSpan): void {
    this.live.set(span.spanId, span);
  }

  release(span: ExportSpan): void {
    this.live.delete(span.spanId);
  }

  keepAncestors(parent: Option.Option<Tracer.AnySpan>): void {
    let current = Option.isSome(parent) ? this.live.get(parent.value.spanId) : undefined;
    while (current !== undefined && !current.kept) {
      current.kept = true;
      current = Option.isSome(current.parent)
        ? this.live.get(current.parent.value.spanId)
        : undefined;
    }
  }
}

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
  // Set once a descendant is exported; only SQLite spans consult it.
  kept = false;
  private readonly delegate: Tracer.Span;
  private readonly sqlite: SqliteSpans | undefined;
  private dropped: Tracer.SpanStatus | undefined;

  constructor(delegate: Tracer.Span, sqlite: SqliteSpans | undefined) {
    this.delegate = delegate;
    this.sqlite = sqlite;
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
    return this.dropped ?? this.delegate.status;
  }

  get attributes(): ReadonlyMap<string, unknown> {
    return this.delegate.attributes;
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    if (this.sqlite !== undefined) {
      this.sqlite.release(this);
      const startTime = this.delegate.status.startTime;
      if (!this.kept && Exit.isSuccess(exit) && endTime - startTime < SLOW_SQLITE_SPAN_NS) {
        this.dropped = { _tag: "Ended", startTime, endTime, exit };
        return;
      }
      this.sqlite.keepAncestors(this.parent);
    }
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
// their error tag, every span ends with its outcome, and fast successful SQLite spans stay local.
export const make = (delegate: Tracer.Tracer): Tracer.Tracer => {
  const sqlite = new SqliteSpans();
  return Tracer.make({
    span: (options) => {
      const isSqlite = SQLITE_SPAN_NAMES.has(options.name);
      // Any other span is always exported, so its SQLite ancestors must be too.
      if (!isSqlite) sqlite.keepAncestors(options.parent);
      const span = new ExportSpan(
        delegate.span({ ...options, links: exportedLinks(options.links) }),
        isSqlite ? sqlite : undefined,
      );
      if (isSqlite) sqlite.register(span);
      return span;
    },
    ...(delegate.context === undefined ? {} : { context: delegate.context }),
  });
};
