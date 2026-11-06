// @effect-diagnostics globalDate:off anyUnknownInErrorContext:off - query failures are recorded, not typed; the harness times Effects from outside the runtime with performance.now.
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";

import { storesLayer, type DatabaseManifest } from "./build.ts";
import { DEEP_THREAD_BASE_RUNS } from "./fixture.ts";
import {
  BUDGET_MS,
  makeContext,
  QUERIES,
  type QueryPath,
  type QuerySpec,
  type Services,
} from "./queries.ts";
import { makeRandom } from "./random.ts";
import { fitPowerLaw, project, summarize, type PowerLawFit, type Summary } from "./stats.ts";

export const RESULTS_VERSION = 1;

export interface CapturedStatement {
  readonly sql: string;
  readonly executions: number;
  readonly plan: ReadonlyArray<string>;
  /** Growing tables this statement scans in full (a SCAN, with or without an index). */
  readonly fullScans: ReadonlyArray<string>;
  readonly planError?: string;
}

export interface ScaleResult {
  readonly scale: number;
  readonly size: number;
  readonly samples: ReadonlyArray<number>;
  readonly summary: Summary | null;
  readonly statements: ReadonlyArray<CapturedStatement>;
  readonly error?: string;
}

export interface QueryResult {
  readonly name: string;
  readonly path: QueryPath;
  readonly calls: string;
  readonly grows: "breadth" | "depth";
  readonly budgetMs: number;
  readonly scales: ReadonlyArray<ScaleResult>;
  readonly fitP50?: PowerLawFit | undefined;
  readonly fitP95?: PowerLawFit | undefined;
  /** p95 projected to 1000x from the fit, when 1000x was not measured. */
  readonly projectedP95At1000?: number | undefined;
  readonly failing: ReadonlyArray<{
    readonly scale: number;
    readonly reasons: ReadonlyArray<string>;
  }>;
}

export interface RunResults {
  readonly version: number;
  readonly label: string;
  readonly startedAt: string;
  readonly gitSha: string;
  readonly machine: {
    readonly cpu: string;
    readonly cpus: number;
    readonly memoryGb: number;
    readonly platform: string;
    readonly node: string;
  };
  readonly budgets: Readonly<Record<QueryPath, number>>;
  readonly databases: ReadonlyArray<{
    readonly scale: number;
    readonly totalRows: number;
    readonly fileBytes: number;
    readonly deepTurns: number;
    readonly rowCounts: Readonly<Record<string, number>>;
  }>;
  readonly queries: ReadonlyArray<QueryResult>;
}

export interface RunOptions {
  readonly label: string;
  readonly gitSha: string;
  readonly seed: number;
  readonly only?: ReadonlyArray<string> | undefined;
  /** Target measured time per query and scale; repetitions adapt to it within the bounds below. */
  readonly targetMs: number;
  readonly minReps: number;
  readonly maxReps: number;
  readonly capMs: number;
  readonly warmup: number;
  readonly log: (line: string) => void;
}

interface Capture {
  active: boolean;
  readonly statements: Map<string, { executions: number; params: ReadonlyArray<unknown> }>;
}
const capture: Capture = { active: false, statements: new Map() };
let patched = false;

function patchStatements() {
  if (patched) return;
  patched = true;
  const proto = NodeSqlite.StatementSync.prototype as unknown as Record<
    string,
    (...args: Array<unknown>) => unknown
  >;
  for (const method of ["all", "get", "run", "iterate"]) {
    const original = proto[method]!;
    proto[method] = function (this: NodeSqlite.StatementSync, ...args: Array<unknown>) {
      if (capture.active) {
        const entry = capture.statements.get(this.sourceSQL);
        if (entry === undefined)
          capture.statements.set(this.sourceSQL, { executions: 1, params: args });
        else entry.executions++;
      }
      return original.apply(this, args);
    };
  }
}

const NOT_PLANNED = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|ANALYZE)\b/i;
const SQL_KEYWORDS = new Set([
  "where",
  "on",
  "left",
  "inner",
  "cross",
  "join",
  "group",
  "order",
  "limit",
  "using",
  "natural",
  "as",
  "union",
  "select",
  "set",
  "values",
  "indexed",
  "not",
]);

/** Maps aliases and table names in the statement to table names. */
function tableAliases(sql: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const match of sql.matchAll(
    /\b(?:FROM|JOIN|UPDATE|INTO)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?(?:\s+(?:AS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?)?/gi,
  )) {
    const table = match[1]!;
    aliases.set(table, table);
    const alias = match[2];
    if (alias !== undefined && !SQL_KEYWORDS.has(alias.toLowerCase())) aliases.set(alias, table);
  }
  return aliases;
}

export function fullScansInPlan(
  sql: string,
  plan: ReadonlyArray<string>,
  growingTables: ReadonlySet<string>,
): Array<string> {
  const aliases = tableAliases(sql);
  const scans = new Set<string>();
  for (const detail of plan) {
    const match = /^\s*SCAN ([A-Za-z_][A-Za-z0-9_]*)/.exec(detail);
    // A virtual table with a constraint (an FTS MATCH) is a lookup; INDEX 0 means no constraint.
    if (match === null || /VIRTUAL TABLE INDEX [1-9]/.test(detail)) continue;
    const name = match[1]!;
    const table = growingTables.has(name) ? name : aliases.get(name);
    if (table !== undefined && growingTables.has(table)) scans.add(table);
  }
  return [...scans].sort();
}

function explain(db: NodeSqlite.DatabaseSync, sql: string, params: ReadonlyArray<unknown>) {
  try {
    const rows = db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...(params as Array<NodeSqlite.SQLInputValue>)) as Array<{
      detail: string;
      id: number;
      parent: number;
    }>;
    const depth = new Map<number, number>();
    return {
      plan: rows.map((row) => {
        const level = (depth.get(row.parent) ?? -1) + 1;
        depth.set(row.id, level);
        return `${"  ".repeat(level)}${row.detail}`;
      }),
    };
  } catch (error) {
    return { plan: [], planError: error instanceof Error ? error.message : String(error) };
  }
}

type StoresRuntime = ManagedRuntime.ManagedRuntime<Services, unknown>;

async function timeOnce(runtime: StoresRuntime, effect: Effect.Effect<unknown, unknown, Services>) {
  const started = performance.now();
  await runtime.runPromise(effect);
  return performance.now() - started;
}

const describeError = (error: unknown) =>
  (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 2_000);

/** Measures every query on one database: warm-up, adaptive repetitions, randomized order. */
export async function runScale(
  manifest: DatabaseManifest,
  options: RunOptions,
  growingTables: ReadonlySet<string>,
) {
  const runtime = ManagedRuntime.make(storesLayer(manifest.dbPath));
  const queries =
    options.only === undefined
      ? QUERIES
      : QUERIES.filter((q) => options.only!.some((name) => q.name.startsWith(name)));
  const samples = new Map<string, Array<number>>();
  const errors = new Map<string, string>();
  try {
    const context = await runtime.runPromise(makeContext(manifest));
    const plan: Array<QuerySpec> = [];
    for (const query of queries) {
      const effect = query.run(context);
      try {
        let warm = 0;
        for (let i = 0; i < options.warmup; i++) warm = await timeOnce(runtime, effect);
        const each = Math.max(warm, 0.01);
        // Slow queries keep at least 5 repetitions within the per-query time cap.
        const reps =
          each * options.minReps > options.capMs
            ? Math.max(5, Math.floor(options.capMs / each))
            : Math.min(
                options.maxReps,
                Math.max(options.minReps, Math.ceil(options.targetMs / each)),
              );
        for (let i = 0; i < reps; i++) plan.push(query);
        samples.set(query.name, []);
        options.log(`  ${manifest.scale}x ${query.name}: warm ${warm.toFixed(2)} ms, ${reps} reps`);
      } catch (error) {
        errors.set(query.name, describeError(error));
        options.log(
          `  ${manifest.scale}x ${query.name}: FAILED ${describeError(error).slice(0, 300)}`,
        );
      }
    }
    const order = makeRandom(options.seed ^ manifest.scale).shuffle(plan);
    for (const query of order) {
      const effect = query.run(context);
      try {
        samples.get(query.name)!.push(await timeOnce(runtime, effect));
      } catch (error) {
        errors.set(query.name, describeError(error));
      }
    }
  } finally {
    await runtime.dispose();
  }

  // Statement capture on a main-thread connection, then plans on a read-only one.
  patchStatements();
  const captureRuntime = ManagedRuntime.make(storesLayer(manifest.dbPath, { capture: true }));
  const statements = new Map<string, Array<CapturedStatement>>();
  const planner = new NodeSqlite.DatabaseSync(manifest.dbPath, { readOnly: true });
  try {
    const context = await captureRuntime.runPromise(makeContext(manifest));
    for (const query of queries) {
      if (errors.has(query.name)) continue;
      capture.statements.clear();
      capture.active = true;
      try {
        await captureRuntime.runPromise(query.run(context));
      } catch {
        // The timed run already recorded failures.
      } finally {
        capture.active = false;
      }
      statements.set(
        query.name,
        [...capture.statements.entries()]
          .filter(([sql]) => !NOT_PLANNED.test(sql))
          .map(([sql, { executions, params }]) => {
            const { plan, planError } = explain(planner, sql, params);
            return {
              sql: sql.replace(/\s+/g, " ").trim(),
              executions,
              plan,
              fullScans: fullScansInPlan(sql, plan, growingTables),
              ...(planError === undefined ? {} : { planError }),
            };
          }),
      );
    }
  } finally {
    planner.close();
    await captureRuntime.dispose();
  }

  return new Map(
    queries.map((query) => {
      const values = samples.get(query.name) ?? [];
      const result: ScaleResult = {
        scale: manifest.scale,
        size: query.grows === "breadth" ? manifest.totalRows : manifest.deep.runCount,
        samples: values.map((value) => Math.round(value * 1_000) / 1_000),
        summary: values.length > 0 ? summarize(values) : null,
        statements: statements.get(query.name) ?? [],
        ...(errors.has(query.name) ? { error: errors.get(query.name)! } : {}),
      };
      return [query.name, result] as const;
    }),
  );
}

/** Tables whose row count grows across the measured scales. */
export function growingTablesOf(manifests: ReadonlyArray<DatabaseManifest>): Set<string> {
  const sorted = [...manifests].sort((a, b) => a.scale - b.scale);
  const first = sorted[0]!;
  const last = sorted.at(-1)!;
  if (first === last) {
    return new Set(
      Object.entries(first.rowCounts)
        .filter(([, n]) => n > 100)
        .map(([table]) => table),
    );
  }
  return new Set(
    Object.entries(last.rowCounts)
      .filter(([table, n]) => n > 2 * (first.rowCounts[table] ?? 0))
      .map(([table]) => table),
  );
}

export function judge(
  query: Omit<QueryResult, "failing" | "fitP50" | "fitP95" | "projectedP95At1000">,
): QueryResult {
  const measured = query.scales.filter((s) => s.summary !== null);
  const fitP50 = fitPowerLaw(
    measured.map((s) => s.size),
    measured.map((s) => s.summary!.p50),
  );
  const fitP95 = fitPowerLaw(
    measured.map((s) => s.size),
    measured.map((s) => s.summary!.p95),
  );
  const largest = [...measured].sort((a, b) => b.scale - a.scale)[0];
  let projectedP95At1000: number | undefined;
  if (fitP95 !== undefined && largest !== undefined && largest.scale < 1000) {
    projectedP95At1000 = project(fitP95, largest.size * (1000 / largest.scale));
  }
  const executions = (s: ScaleResult) =>
    s.statements.reduce((total, statement) => total + statement.executions, 0);
  const smallest = [...query.scales]
    .sort((a, b) => a.scale - b.scale)
    .find((s) => s.statements.length > 0);
  const failing = query.scales
    .map((s) => {
      const reasons: Array<string> = [];
      if (s.error !== undefined) reasons.push("error");
      if (s.summary !== null && s.summary.p95 > query.budgetMs)
        reasons.push(`p95 ${s.summary.p95.toFixed(1)} ms > ${query.budgetMs} ms`);
      const scanned = [...new Set(s.statements.flatMap((statement) => statement.fullScans))];
      if (scanned.length > 0) reasons.push(`full scan: ${scanned.join(", ")}`);
      // A paged sweep or a per-row loop shows as statement executions that grow with the data.
      if (
        smallest !== undefined &&
        s.scale > smallest.scale &&
        executions(s) > 2 * executions(smallest)
      ) {
        reasons.push(`statements executed grow ${executions(smallest)} → ${executions(s)}`);
      }
      return { scale: s.scale, reasons };
    })
    .filter((f) => f.reasons.length > 0);
  return { ...query, fitP50, fitP95, projectedP95At1000, failing };
}

export async function runAll(
  manifests: ReadonlyArray<DatabaseManifest>,
  options: RunOptions,
): Promise<RunResults> {
  const startedAt = new Date().toISOString();
  const growing = growingTablesOf(manifests);
  const perScale = new Map<number, Map<string, ScaleResult>>();
  for (const manifest of manifests) {
    options.log(`${manifest.scale}x: measuring (${manifest.totalRows} rows)`);
    perScale.set(manifest.scale, await runScale(manifest, options, growing));
  }
  const queries = (
    options.only === undefined
      ? QUERIES
      : QUERIES.filter((q) => options.only!.some((name) => q.name.startsWith(name)))
  ).map((query) =>
    judge({
      name: query.name,
      path: query.path,
      calls: query.calls,
      grows: query.grows,
      budgetMs: BUDGET_MS[query.path],
      scales: manifests.map((m) => perScale.get(m.scale)!.get(query.name)!),
    }),
  );
  const cpus = NodeOS.cpus();
  return {
    version: RESULTS_VERSION,
    label: options.label,
    startedAt,
    gitSha: options.gitSha,
    machine: {
      cpu: cpus[0]?.model ?? "unknown",
      cpus: cpus.length,
      memoryGb: Math.round(NodeOS.totalmem() / 2 ** 30),
      // oxlint-disable-next-line houston/no-global-process-runtime -- records the machine that took the timings.
      platform: `${NodeOS.platform()} ${NodeOS.release()}`,
      node: process.version,
    },
    budgets: BUDGET_MS,
    databases: manifests.map((m) => ({
      scale: m.scale,
      totalRows: m.totalRows,
      fileBytes: m.fileBytes,
      deepTurns: m.deep.runCount ?? DEEP_THREAD_BASE_RUNS * m.scale,
      rowCounts: m.rowCounts,
    })),
    queries,
  };
}
