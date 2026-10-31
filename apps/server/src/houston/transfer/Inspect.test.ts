// @effect-diagnostics nodeBuiltinImport:off - builds the two computers' folders and lists them.
// houston.transfer.inspect on another computer than the one that exported: the summary comes from
// the manifest alone, and nothing is written.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { TransferProbe } from "./probe.ts";
import { HoustonTransferService } from "./Service.ts";
import {
  commitAll,
  createProject,
  git,
  layerTransferTest,
  makeRepos,
  PASSPHRASE,
  seedThread,
  write,
} from "./transfer.testkit.ts";

type Services = Layer.Success<ReturnType<typeof layerTransferTest>>;

const onComputer = <A, E>(body: Effect.Effect<A, E, Services | Scope.Scope>) =>
  body.pipe(
    Effect.provide(layerTransferTest({ workFactor: 10 })),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  );

describe("inspect summarises a file without unpacking it", () => {
  it.effect("inspect summarises a file without unpacking it", () =>
    Effect.gen(function* () {
      // Computer A: a project whose origin is GitHub's O/R over HTTPS, with a local commit.
      const repos = makeRepos("houston-transfer-inspect-", "O/R");
      write(repos.checkout, "feature.txt", "local\n");
      commitAll(repos.checkout, "local commit");
      write(repos.checkout, ".claude/settings.local.json", "{}\n");
      write(repos.checkout, "CLAUDE.md", "# agents\n");
      write(repos.checkout, "docs/claude.md", "not configuration\n");
      const destination = NodePath.join(repos.root, "out", "move");
      NodeFS.mkdirSync(NodePath.dirname(destination));
      const exported = yield* onComputer(
        Effect.gen(function* () {
          const projectId = yield* createProject("source", repos.checkout);
          yield* seedThread({ threadId: "t-inspect", projectId, title: "Carried thread" });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO houston_tasks (number, project_id, title, status, created_by, created_at,
              updated_at)
            VALUES (1, ${projectId}, 'A task', 'backlog', 'user', 'now', 'now')
          `;
          const service = yield* HoustonTransferService;
          return yield* service.export({
            projectId,
            destination,
            passphrase: Redacted.make(PASSPHRASE),
          });
        }),
      );

      // Computer B: the same repository cloned over SSH, and an unrelated one.
      const target = makeRepos("houston-transfer-inspect-target-", "o/r");
      git(target.checkout, ["remote", "set-url", "origin", "git@github.com:o/r"]);
      const other = makeRepos("houston-transfer-inspect-other-", "o/r2");
      yield* onComputer(
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          yield* createProject("unrelated", other.checkout);
          const targetId = yield* createProject("target", target.checkout);
          const service = yield* HoustonTransferService;
          const frames: Array<string> = [];
          const inspect = service
            .inspect({ file: exported.file, passphrase: Redacted.make(PASSPHRASE) })
            .pipe(
              Effect.provideService(TransferProbe, {
                ...TransferProbe.defaultValue(),
                onFrame: (name) => frames.push(name),
              }),
            );
          const before = NodeFS.readdirSync(config.baseDir).toSorted();
          const summary = yield* inspect;
          assert.deepEqual(frames, ["manifest.json"]);
          assert.strictEqual(summary.transferId, exported.transferId);
          assert.strictEqual(summary.format, 2);
          assert.strictEqual(
            summary.sourceOs,
            (yield* HostProcess.Platform) === "win32" ? "win32" : "linux",
          );
          assert.deepEqual(summary.source, {
            title: "source",
            root: repos.checkout,
            remoteUrl: "https://github.com/O/R.git",
          });
          assert.isString(summary.createdAt);
          assert.deepEqual(
            summary.threads.map((thread) => [thread.threadId, thread.title, thread.checkout]),
            [["t-inspect", "Carried thread", "root"]],
          );
          assert.deepEqual(summary.skipped, []);
          assert.strictEqual(summary.checkouts.length, 1);
          const [checkout] = summary.checkouts;
          assert.strictEqual(checkout!.key, "root");
          assert.strictEqual(checkout!.branch, "main");
          assert.strictEqual(checkout!.head, git(repos.checkout, ["rev-parse", "HEAD"]));
          assert.isTrue(checkout!.carriesCommits);
          assert.strictEqual(checkout!.untracked, 3);
          assert.deepEqual(checkout!.agentConfigPaths, [
            ".claude/settings.local.json",
            "CLAUDE.md",
          ]);
          assert.deepEqual(summary.counts, {
            tasks: 1,
            taskSourceLinks: 0,
            viewedFiles: 0,
            attachments: 0,
          });
          assert.strictEqual(summary.proposedProjectId, targetId);
          assert.deepEqual(summary.importedInto, []);
          // Nothing new in the base dir, and no scratch folder left behind.
          assert.deepEqual(NodeFS.readdirSync(config.baseDir).toSorted(), before);
          const scratch = NodePath.join(config.baseDir, "houston", "transfer", "scratch");
          assert.isTrue(!NodeFS.existsSync(scratch) || NodeFS.readdirSync(scratch).length === 0);

          // After an import into the target, inspect names it.
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO houston_transfer_imports (import_id, transfer_id, project_id, state,
              journal_json, started_at, ended_at)
            VALUES ('import-1', ${exported.transferId}, ${targetId}, 'done', '[]',
              '2026-10-30T12:00:00.000Z', '2026-10-30T12:01:00.000Z')
          `;
          yield* sql`
            INSERT INTO houston_transfer_imports (import_id, transfer_id, project_id, state,
              journal_json, started_at, ended_at)
            VALUES ('import-0', ${exported.transferId}, 'project-unrelated', 'undone', '[]',
              '2026-10-30T11:00:00.000Z', '2026-10-30T11:01:00.000Z')
          `;
          const again = yield* service.inspect({
            file: exported.file,
            passphrase: Redacted.make(PASSPHRASE),
          });
          assert.deepEqual(again.importedInto, [
            { projectId: targetId, importedAt: "2026-10-30T12:01:00.000Z" },
          ]);
        }),
      );
    }),
  );
});
