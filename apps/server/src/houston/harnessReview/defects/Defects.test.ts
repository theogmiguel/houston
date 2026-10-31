// @effect-diagnostics nodeBuiltinImport:off - the home directory a report may name, and the source scan.
// Suspected defects over one database: agent reports, dedupe, the project cap, decisions,
// recurrence and the daily notice. Nothing here may reach GitHub.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { ThreadId, type ProjectId } from "@t3tools/contracts";
import type { HoustonHarnessOverviewEvent } from "@t3tools/contracts/houston/harnessReview";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import {
  HoustonDefects,
  HoustonHarnessService,
  createProject,
  makeKit,
  runKit,
  sql,
} from "../harnessReview.testkit.ts";

const TIMEOUT = 180_000;
const NOTE = "Stored as a suspected defect; nothing is sent anywhere.";
const defects = HoustonDefects.HoustonDefects;
const service = HoustonHarnessService.HoustonHarnessService;

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.isTrue(Exit.isFailure(exit), "expected a refusal");
  return Cause.squash((exit as Exit.Failure<A, E>).cause) as {
    readonly kind?: string;
    readonly message?: string;
  };
};

const report = (
  projectId: ProjectId,
  title: string,
  extra: {
    readonly description?: string;
    readonly evidence?: ReadonlyArray<string>;
    readonly destination?: "houston" | "project";
  } = {},
) =>
  Effect.flatMap(defects, (store) =>
    store.report({
      projectId,
      threadId: ThreadId.make("thread-reporter"),
      title,
      destination: extra.destination ?? "houston",
      ...(extra.description === undefined ? {} : { description: extra.description }),
      ...(extra.evidence === undefined ? {} : { evidence: extra.evidence }),
    }),
  );

const defectsOf = (projectId: ProjectId) =>
  Effect.flatMap(service, (harness) => harness.get({ projectId })).pipe(
    Effect.map((snapshot) => snapshot.defects),
  );

describe("agent reports", () => {
  it.effect(
    "an agent report is stored and deduplicated",
    () =>
      Effect.gen(function* () {
        const kit = yield* makeKit("defect-dedupe", { reactor: false });
        yield* runKit(
          kit,
          Effect.gen(function* () {
            const { projectId } = yield* createProject("defect-dedupe");
            const { projectId: other } = yield* createProject("defect-dedupe-other");
            const first = yield* report(projectId, "A  broken\tThing", {
              description: "first description",
              evidence: ["e1", "e2"],
            });
            assert.isTrue(first.recorded);
            assert.match(first.key, /^defect-agent-[0-9a-f]{8}$/);
            assert.strictEqual(first.count, 1);
            assert.strictEqual(first.note, NOTE);
            const [stored] = yield* defectsOf(projectId);
            assert.strictEqual(stored?.key, first.key);
            assert.strictEqual(stored?.count, 1);
            assert.strictEqual(stored?.source, "agent");
            assert.strictEqual(stored?.firstSeenAt, stored?.lastSeenAt);
            assert.lengthOf(yield* defectsOf(other), 0, "the defect belongs to its project");

            yield* TestClock.adjust("1 minute");
            const again = yield* report(projectId, "a broken thing", {
              description: "second description",
              evidence: ["e2", "e3", ...Array.from({ length: 12 }, (_, index) => `x${index}`)],
            });
            assert.strictEqual(again.key, first.key);
            assert.strictEqual(again.count, 2);
            const [merged] = yield* defectsOf(projectId);
            assert.strictEqual(merged?.count, 2);
            assert.strictEqual(merged?.description, "second description");
            assert.notStrictEqual(merged?.lastSeenAt, merged?.firstSeenAt);
            assert.deepEqual(merged?.evidence.slice(0, 3), ["e1", "e2", "e3"]);
            assert.lengthOf(merged?.evidence ?? [], 10);

            const toProject = yield* report(projectId, "a broken thing", {
              destination: "project",
            });
            assert.notStrictEqual(toProject.key, first.key);
            assert.strictEqual(toProject.count, 1);
            assert.lengthOf(yield* defectsOf(projectId), 2);
            assert.lengthOf(kit.github.requests, 0, "no GitHub request");
          }),
        );
      }),
    TIMEOUT,
  );

  it.effect(
    "a report is stored without secrets or the home path",
    () =>
      Effect.gen(function* () {
        const kit = yield* makeKit("defect-redacted", { reactor: false });
        yield* runKit(
          kit,
          Effect.gen(function* () {
            const { projectId, root } = yield* createProject("defect-redacted");
            const home = NodeOS.homedir();
            const token = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
            const notes = NodePath.join(home, "notes.txt");
            const source = NodePath.join(root, "src", "a.ts");
            yield* report(projectId, `push failed with ${token}`, {
              description: `GITHUB_TOKEN=${token} while reading ${notes}`,
              evidence: [`log at ${notes}`, `edited ${source}`],
            });
            const [stored] = yield* defectsOf(projectId);
            const served = JSON.stringify(stored);
            assert.notInclude(served, token);
            assert.notInclude(served, home);
            assert.include(stored?.description ?? "", "GITHUB_TOKEN=<redacted>");
            assert.include(stored?.description ?? "", `~${NodePath.sep}notes.txt`);
            assert.include(stored?.evidence[1] ?? "", `<project>${NodePath.sep}src`);
            const database = yield* sql;
            const rows = yield* database`SELECT * FROM houston_defects`;
            assert.notInclude(JSON.stringify(rows), token, "nothing secret is stored");
          }),
        );
      }),
    TIMEOUT,
  );

  it.effect(
    "a full project prunes its oldest decided defect or refuses",
    () =>
      Effect.gen(function* () {
        const kit = yield* makeKit("defect-cap", { reactor: false });
        yield* runKit(
          kit,
          Effect.gen(function* () {
            const { projectId } = yield* createProject("defect-cap");
            const keys: Array<string> = [];
            for (let index = 0; index < 200; index += 1) {
              keys.push((yield* report(projectId, `defect number ${index}`)).key);
            }
            const store = yield* defects;
            const refused = failureOf(
              yield* Effect.exit(report(projectId, "one defect too many")),
            );
            assert.strictEqual(refused.kind, "limit");
            assert.strictEqual(
              refused.message,
              "the project holds 200 defects and its limit is 200; decide one before reporting more",
            );
            assert.lengthOf(yield* defectsOf(projectId), 200, "a refusal stores nothing");

            yield* store.decide({ projectId, key: keys[0]!, decision: "dismiss" });
            yield* TestClock.adjust("1 minute");
            yield* store.decide({ projectId, key: keys[1]!, decision: "notABug" });
            yield* TestClock.adjust("1 minute");
            const stored = yield* report(projectId, "one defect too many");
            assert.strictEqual(stored.count, 1);
            const held = (yield* defectsOf(projectId)).map((defect) => defect.key);
            assert.lengthOf(held, 200);
            assert.notInclude(held, keys[0], "the oldest decision is pruned");
            assert.include(held, keys[1]);
            assert.include(held, stored.key);
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("decisions", () => {
  it.effect(
    "a dismissed defect that recurs is open again",
    () =>
      Effect.gen(function* () {
        const kit = yield* makeKit("defect-decide", { reactor: false });
        yield* runKit(
          kit,
          Effect.gen(function* () {
            const { projectId } = yield* createProject("defect-decide");
            const store = yield* defects;
            const database = yield* sql;
            const { key } = yield* report(projectId, "worker re-asked the same question");
            const decidedBy = database<{ decided_by: string }>`
              SELECT decided_by FROM houston_harness_decisions WHERE key = ${key}`;
            const stateOf = Effect.map(defectsOf(projectId), (rows) =>
              rows.find((row) => row.key === key),
            );

            yield* TestClock.adjust("1 minute");
            yield* store.decide({ projectId, key, decision: "dismiss" });
            assert.strictEqual((yield* stateOf)?.state, "dismissed");
            assert.deepEqual(yield* decidedBy, [{ decided_by: "user" }]);

            yield* store.decide({ projectId, key, decision: "notABug" });
            assert.strictEqual((yield* stateOf)?.state, "dismissed");
            assert.deepEqual(yield* decidedBy, [{ decided_by: "not_a_bug" }]);

            yield* store.decide({ projectId, key, decision: "reopen" });
            assert.strictEqual((yield* stateOf)?.state, "open");
            assert.isFalse((yield* stateOf)?.recurred);

            yield* store.decide({ projectId, key, decision: "dismiss" });
            yield* TestClock.adjust("1 minute");
            yield* report(projectId, "worker re-asked the same question");
            const recurred = yield* stateOf;
            assert.strictEqual(recurred?.state, "open");
            assert.isTrue(recurred?.recurred);

            const unknown = failureOf(
              yield* Effect.exit(
                store.decide({ projectId, key: "defect-agent-00000000", decision: "dismiss" }),
              ),
            );
            assert.strictEqual(unknown.kind, "not_found");
            assert.include(unknown.message ?? "", "defect-agent-00000000");
            assert.lengthOf(kit.github.requests, 0);
          }),
        );
      }),
    TIMEOUT,
  );
});

describe("the daily notice", () => {
  it.effect(
    "the defect notice is sent once per project per day",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-defect-notice-" });
        const databaseFile = NodePath.join(dir, "state.sqlite");
        const notices = (events: ReadonlyArray<HoustonHarnessOverviewEvent>) =>
          events.filter((event) => event.type === "defectNotice");
        const listen = Effect.gen(function* () {
          const events = yield* Ref.make<ReadonlyArray<HoustonHarnessOverviewEvent>>([]);
          const harness = yield* service;
          yield* harness
            .subscribeOverview({})
            .pipe(
              Stream.runForEach((event) => Ref.update(events, (all) => [...all, event])),
              Effect.forkScoped,
            );
          // The first event is the overview itself.
          for (let round = 0; round < 50; round += 1) {
            if ((yield* Ref.get(events)).length > 0) break;
            yield* Effect.yieldNow;
          }
          return events;
        });
        const drain = Effect.gen(function* () {
          for (let round = 0; round < 50; round += 1) yield* Effect.yieldNow;
        });

        const first = yield* makeKit("defect-notice", { reactor: false, databaseFile });
        const projectId = yield* runKit(
          first,
          Effect.gen(function* () {
            const { projectId } = yield* createProject("defect-notice");
            const events = yield* listen;
            yield* report(projectId, "first defect today");
            yield* drain;
            yield* report(projectId, "second defect today");
            yield* drain;
            const sent = notices(yield* Ref.get(events));
            assert.deepEqual(sent, [
              { type: "defectNotice", projectId, count: 1, title: "first defect today" },
            ]);
            const overview = yield* (yield* service).overview({});
            const row = overview.rows.find((candidate) => candidate.projectId === projectId);
            assert.strictEqual(row?.suspectedDefects, 2);
            assert.strictEqual(row?.attention, 2);

            yield* TestClock.adjust("1 day");
            yield* report(projectId, "a defect the next day");
            yield* drain;
            const nextDay = notices(yield* Ref.get(events));
            assert.lengthOf(nextDay, 2);
            assert.deepInclude(nextDay[1], {
              projectId,
              count: 3,
              title: "a defect the next day",
            });
            return projectId;
          }),
        );

        const restarted = yield* makeKit("defect-notice-restart", {
          reactor: false,
          databaseFile,
        });
        yield* runKit(
          restarted,
          Effect.gen(function* () {
            // The same UTC day as the last notice: the stored day holds it back.
            const events = yield* listen;
            yield* report(projectId, "after the restart");
            yield* drain;
            assert.lengthOf(notices(yield* Ref.get(events)), 0);
          }),
        );
      }).pipe(Effect.scoped),
    TIMEOUT,
  );
});

describe("detectors", () => {
  it("no v2 code records a detector defect", () => {
    const root = NodePath.resolve(import.meta.dirname, "..", "..");
    const files: Array<string> = [];
    const walk = (dir: string) => {
      for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
        const full = NodePath.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
      }
    };
    walk(root);
    const writers: Array<string> = [];
    for (const file of files) {
      const text = NodeFS.readFileSync(file, "utf8");
      const inserts = text.match(/INSERT INTO houston_defects[\s\S]*?`/g) ?? [];
      if (inserts.length === 0) continue;
      writers.push(NodePath.relative(root, file).split(NodePath.sep).join("/"));
      if (NodePath.basename(file) === "V1Import.ts") continue;
      for (const statement of inserts) {
        assert.include(statement, "'agent'", `${file} records only agent defects`);
        assert.notInclude(statement, "detector'", file);
      }
    }
    assert.include(writers, "harnessReview/V1Import.ts");
    assert.isAbove(writers.length, 1, "the store writes agent defects");
  });
});
