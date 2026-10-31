// @effect-diagnostics nodeBuiltinImport:off - reads the written file and the fixture folders back.
// houston.transfer.export over the real project service, event sink, git and a memory keychain.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import type {
  HoustonTransferError,
  HoustonTransferExportSummary,
  HoustonTransferManifest,
} from "@t3tools/contracts/houston/transfer";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { pushBranch } from "../mergeQueue/mergeQueue.testkit.ts";
import * as HoustonKeychain from "../secrets/HoustonKeychain.ts";
import { decryptPlaintext, readFrames } from "./format.ts";
import { TransferProbe } from "./probe.ts";
import { HoustonTransferService } from "./Service.ts";
import {
  addManagedWorktree,
  commitAll,
  createProject,
  git,
  layerTransferTest,
  makeRepos,
  PASSPHRASE,
  seedRun,
  seedThread,
  write,
  type TransferTestOptions,
} from "./transfer.testkit.ts";

type Services = Layer.Success<ReturnType<typeof layerTransferTest>>;

const withComputer = <A, E>(
  body: Effect.Effect<A, E, Services | Scope.Scope>,
  options: TransferTestOptions = {},
) =>
  body.pipe(
    Effect.provide(layerTransferTest({ workFactor: 10, ...options })),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  );

const exportProject = (
  projectId: ProjectId,
  destination: string,
  extra: {
    readonly overwrite?: boolean;
    readonly renderer?: string;
    readonly passphrase?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const service = yield* HoustonTransferService;
    return yield* service.export({
      projectId,
      destination,
      passphrase: Redacted.make(extra.passphrase ?? PASSPHRASE),
      ...(extra.overwrite === undefined ? {} : { overwrite: extra.overwrite }),
      ...(extra.renderer === undefined ? {} : { renderer: extra.renderer }),
    });
  });

const refusalOf = <A, R>(effect: Effect.Effect<A, HoustonTransferError, R>) => Effect.flip(effect);

const framesOf = (file: string) =>
  Effect.promise(() => decryptPlaintext(file, PASSPHRASE)).pipe(Effect.map(readFrames));

const manifestOf = (frames: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>) =>
  JSON.parse(Buffer.from(frames[0]!.bytes).toString("utf8")) as HoustonTransferManifest;

const frameText = (
  frames: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>,
  name: string,
) => {
  const frame = frames.find((entry) => entry.name === name);
  assert.isDefined(frame, name);
  return Buffer.from(frame!.bytes).toString("utf8");
};

const destinationIn = (root: string, name = "move") => {
  const folder = NodePath.join(root, "out");
  NodeFS.mkdirSync(folder, { recursive: true });
  return NodePath.join(folder, name);
};

const insertTask = (projectId: string, number: number, title: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly id: number }>`
      INSERT INTO houston_tasks (number, project_id, title, status, created_by, created_at, updated_at)
      VALUES (${number}, ${projectId}, ${title}, 'backlog', 'user', 'now', 'now')
      RETURNING id
    `;
    return row!.id;
  });

/** A project at a fresh checkout with one thread and one untracked file. */
const simpleProject = (name: string) =>
  Effect.gen(function* () {
    const repos = makeRepos(`houston-transfer-${name}-`);
    write(repos.checkout, "notes.txt", "untracked\n");
    const projectId = yield* createProject(name, repos.checkout);
    yield* seedThread({
      threadId: `thread-${name}`,
      projectId,
      title: `Thread of ${name}`,
      messages: ["Fix it", "Fixed"],
    });
    return { repos, projectId };
  });

describe("an export writes a format 2 file and records it", () => {
  it.effect("an export writes a format 2 file and records it", () =>
    withComputer(
      Effect.gen(function* () {
        const repos = makeRepos("houston-transfer-c1-");
        write(repos.checkout, "notes.txt", "untracked\n");
        const projectId = yield* createProject("c1", repos.checkout);
        const first = yield* seedThread({
          threadId: "thread-c1-a",
          projectId,
          title: "First thread",
          messages: ["Hello", "Hi"],
        });
        const second = yield* seedThread({
          threadId: "thread-c1-b",
          projectId,
          title: "Second thread",
          instanceId: "claudeAgent",
        });
        yield* insertTask(projectId, 1, "One task");
        const destination = destinationIn(repos.root);

        const summary: HoustonTransferExportSummary = yield* exportProject(projectId, destination);
        const file = `${destination}.houston-transfer`;
        assert.strictEqual(summary.file, file);
        assert.strictEqual(summary.bytes, NodeFS.statSync(file).size);
        assert.deepEqual(
          summary.threads.map((thread) => [thread.threadId, thread.title, thread.checkout]),
          [
            [first, "First thread", "root"],
            [second, "Second thread", "root"],
          ],
        );
        assert.deepEqual(
          summary.threads.map((thread) => thread.provider),
          ["codex", "claudeAgent"],
        );
        assert.deepEqual(summary.skipped, []);
        assert.deepEqual(summary.skippedPaths, []);

        const frames = yield* framesOf(file);
        assert.strictEqual(frames[0]!.name, "manifest.json");
        const manifest = manifestOf(frames);
        assert.strictEqual(manifest.format, 2);
        assert.strictEqual(manifest.transferId, summary.transferId);
        assert.deepEqual(manifest.checkouts[0]!.untracked, ["notes.txt"]);
        assert.strictEqual(frameText(frames, "checkouts/0/untracked/notes.txt"), "untracked\n");
        assert.include(frameText(frames, "threads/0/history.ndjson"), "Hello");
        assert.include(frameText(frames, "sections/tasks.json"), "One task");

        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly transfer_id: string;
          readonly project_id: string;
          readonly bytes: number;
          readonly file: string;
        }>`SELECT transfer_id, project_id, bytes, file FROM houston_transfer_exports`;
        assert.deepEqual(rows, [
          { transfer_id: summary.transferId, project_id: projectId, bytes: summary.bytes, file },
        ]);
      }),
    ),
  );
});

describe("a refused passphrase writes nothing", () => {
  it.effect("a refused passphrase writes nothing", () =>
    withComputer(
      Effect.gen(function* () {
        const { repos, projectId } = yield* simpleProject("c2");
        const destination = destinationIn(repos.root);
        for (const [passphrase, kind, limit] of [
          ["a".repeat(11), "invalid", 12],
          ["b".repeat(1_025), "limit", 1_024],
        ] as const) {
          const refusal = yield* refusalOf(exportProject(projectId, destination, { passphrase }));
          assert.strictEqual(refusal.kind, kind);
          assert.strictEqual(refusal.limit, limit);
          assert.strictEqual(refusal.operation, "houston.transfer.export");
          assert.notInclude(JSON.stringify(refusal), passphrase.slice(0, 11));
          assert.deepEqual(NodeFS.readdirSync(NodePath.dirname(destination)), []);
        }
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* sql`SELECT * FROM houston_transfer_exports`, []);
        // Twelve characters of four bytes each are accepted.
        yield* exportProject(projectId, destination, { passphrase: "\u{1F600}".repeat(12) });
        assert.deepEqual(NodeFS.readdirSync(NodePath.dirname(destination)), [
          "move.houston-transfer",
        ]);
      }),
    ),
  );
});

describe("an export never replaces a file unasked and leaves no partial file", () => {
  it.effect("an export never replaces a file unasked and leaves no partial file", () =>
    Effect.gen(function* () {
      yield* withComputer(
        Effect.gen(function* () {
          const { repos, projectId } = yield* simpleProject("c3");
          const relative = yield* refusalOf(exportProject(projectId, "move"));
          assert.strictEqual(relative.kind, "invalid");
          assert.include(relative.items, "move");

          const missing = NodePath.join(repos.root, "missing", "move");
          const absent = yield* refusalOf(exportProject(projectId, missing));
          assert.strictEqual(absent.kind, "invalid");
          assert.include(absent.items, NodePath.dirname(missing));
          assert.isFalse(NodeFS.existsSync(NodePath.dirname(missing)));

          const destination = destinationIn(repos.root);
          const file = `${destination}.houston-transfer`;
          NodeFS.writeFileSync(file, "keep me\n");
          const exists = yield* refusalOf(exportProject(projectId, destination));
          assert.strictEqual(exists.kind, "destination_exists");
          assert.deepEqual(exists.items, [file]);
          assert.strictEqual(NodeFS.readFileSync(file, "utf8"), "keep me\n");

          yield* exportProject(projectId, destination, { overwrite: true });
          assert.notStrictEqual(NodeFS.readFileSync(file, "utf8"), "keep me\n");
          assert.deepEqual(NodeFS.readdirSync(NodePath.dirname(destination)), [
            "move.houston-transfer",
          ]);
        }),
      );

      // Failing while packing: a file limit the checkout's bytes exceed.
      yield* withComputer(
        Effect.gen(function* () {
          const { repos, projectId } = yield* simpleProject("c3-pack");
          write(repos.checkout, "big.bin", NodeCrypto.randomBytes(256 * 1024));
          const destination = destinationIn(repos.root);
          const refusal = yield* refusalOf(exportProject(projectId, destination));
          assert.strictEqual(refusal.kind, "too_large");
          assert.deepEqual(NodeFS.readdirSync(NodePath.dirname(destination)), []);
        }),
        { limits: { fileBytes: 16 * 1024 } },
      );
    }),
  );
});

describe("export carries the project's threads in its root and managed worktrees", () => {
  it.effect("export carries the project's threads in its root and managed worktrees", () =>
    withComputer(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const repos = makeRepos("houston-transfer-c4-");
        pushBranch(repos, "feature", { "feature.txt": "feature\n" });
        const worktree = addManagedWorktree(repos, config.worktreesDir, "feature");
        write(worktree, "wip.txt", "work in progress\n");
        const projectId = yield* createProject("c4", repos.checkout);
        const root = yield* seedThread({ threadId: "t-root", projectId, title: "In the root" });
        const managed = yield* seedThread({
          threadId: "t-managed",
          projectId,
          title: "In a worktree",
          worktreePath: worktree,
          branch: "feature",
        });
        const archived = yield* seedThread({
          threadId: "t-archived",
          projectId,
          title: "Archived",
          archived: true,
        });
        const side = yield* seedThread({
          threadId: "t-side",
          projectId,
          title: "Side of the root",
          parentThreadId: "t-root",
        });
        const outsideFolder = NodePath.join(repos.root, "elsewhere");
        NodeFS.mkdirSync(outsideFolder);
        yield* seedThread({
          threadId: "t-outside",
          projectId,
          title: "Elsewhere",
          worktreePath: outsideFolder,
        });
        yield* seedThread({ threadId: "t-deleted", projectId, title: "Deleted", deleted: true });

        const summary = yield* exportProject(projectId, destinationIn(repos.root));
        assert.deepEqual(
          summary.threads.map((thread) => thread.threadId),
          [root, managed, archived, side],
        );
        assert.deepEqual(
          summary.threads.map((thread) => thread.checkout),
          ["root", "worktree:1", "root", "root"],
        );
        assert.deepEqual(summary.skipped, [
          {
            threadId: ThreadId.make("t-outside"),
            title: "Elsewhere",
            reason: "runs in a folder outside the project and its managed worktrees",
          },
        ]);

        const frames = yield* framesOf(summary.file);
        const manifest = manifestOf(frames);
        assert.deepEqual(
          manifest.checkouts.map((checkout) => [checkout.key, checkout.branch]),
          [
            ["root", "main"],
            ["worktree:1", "feature"],
          ],
        );
        assert.deepEqual(manifest.checkouts[1]!.untracked, ["wip.txt"]);
        const threadJson = (index: number) =>
          JSON.parse(frameText(frames, `threads/${index}/thread.json`)) as Record<string, any>;
        assert.isNotNull(threadJson(2).archivedAt);
        assert.isNull(threadJson(0).archivedAt);
        assert.strictEqual(threadJson(3).lineage.parentThreadId, "t-root");
        assert.notInclude(JSON.stringify(manifest), "t-deleted");
      }),
    ),
  );
});

describe("a thread with an open run or request blocks the export by name", () => {
  it.effect("a thread with an open run or request blocks the export by name", () =>
    withComputer(
      Effect.gen(function* () {
        const cases = [
          { name: "running", status: "running" as const, options: {}, state: "running" },
          {
            name: "request",
            status: "completed" as const,
            options: { pendingRequest: true },
            state: "waiting for an answer",
          },
          {
            name: "starting",
            status: "starting" as const,
            options: { attemptStatus: "pending" },
            state: "starting",
          },
        ];
        for (const entry of cases) {
          const repos = makeRepos(`houston-transfer-c5-${entry.name}-`);
          const projectId = yield* createProject(`c5-${entry.name}`, repos.checkout);
          const threadId = yield* seedThread({
            threadId: `t-c5-${entry.name}`,
            projectId,
            title: `Busy ${entry.name}`,
          });
          yield* seedThread({ threadId: `t-c5-${entry.name}-idle`, projectId, title: "Idle" });
          yield* seedRun(threadId, entry.status, entry.options);
          const destination = destinationIn(repos.root);
          const refusal = yield* refusalOf(exportProject(projectId, destination));
          assert.strictEqual(refusal.kind, "busy_threads", entry.name);
          assert.deepEqual(refusal.items, [`Busy ${entry.name}: ${entry.state}`], entry.name);
          assert.deepEqual(NodeFS.readdirSync(NodePath.dirname(destination)), [], entry.name);
        }

        const repos = makeRepos("houston-transfer-c5-done-");
        const projectId = yield* createProject("c5-done", repos.checkout);
        const threadId = yield* seedThread({ threadId: "t-c5-done", projectId, title: "Done" });
        for (const status of ["completed", "failed", "interrupted", "cancelled"] as const) {
          yield* seedRun(threadId, status);
        }
        const summary = yield* exportProject(projectId, destinationIn(repos.root));
        assert.deepEqual(
          summary.threads.map((thread) => thread.title),
          ["Done"],
        );
      }),
    ),
  );
});

describe("an untracked secret file refuses the export and an ignored one is never read", () => {
  it.effect("an untracked secret file refuses the export and an ignored one is never read", () =>
    withComputer(
      Effect.gen(function* () {
        const { repos, projectId } = yield* simpleProject("c8");
        write(repos.checkout, ".env", "API_TOKEN=untracked-secret-value\n");
        write(repos.checkout, "config/prod.key", "-----BEGIN KEY-----\n");
        write(repos.checkout, ".env.example", "API_TOKEN=\n");
        write(repos.checkout, "keys.md", "# keys\n");
        const destination = destinationIn(repos.root);
        const refusal = yield* refusalOf(exportProject(projectId, destination));
        assert.strictEqual(refusal.kind, "secret_files");
        assert.deepEqual(refusal.items, [".env", "config/prod.key"]);
        assert.deepEqual(refusal.steps, [
          "Add each listed file to .gitignore, move it out of the project or delete it, then export again.",
        ]);
        assert.deepEqual(NodeFS.readdirSync(NodePath.dirname(destination)), []);

        // Ignored, the same files are neither carried nor refused, and never opened.
        write(repos.checkout, ".gitignore", ".env\n*.key\n");
        git(repos.checkout, ["add", ".gitignore"]);
        git(repos.checkout, ["commit", "--quiet", "-m", "ignore secrets"]);
        const reads: Array<string> = [];
        const summary = yield* exportProject(projectId, destination).pipe(
          Effect.provideService(TransferProbe, {
            ...TransferProbe.defaultValue(),
            onFileRead: (path) => reads.push(path),
          }),
        );
        assert.isNotEmpty(reads);
        assert.isFalse(
          reads.some((path) => /\.env$|prod\.key$/.test(path)),
          reads.join("\n"),
        );
        const frames = yield* framesOf(summary.file);
        assert.deepEqual([...manifestOf(frames).checkouts[0]!.untracked].toSorted(), [
          ".env.example",
          "keys.md",
          "notes.txt",
        ]);
        const plain = Buffer.concat(frames.map((frame) => frame.bytes));
        assert.isFalse(plain.includes("untracked-secret-value"));
        assert.isFalse(plain.includes("BEGIN KEY"));
      }),
    ),
  );
});

describe("no credential reaches the file", () => {
  it.effect("no credential reaches the file", () => {
    const keychain = HoustonKeychain.makeMemory();
    keychain.entries.set("houston-tracker-c9\u0000project-c9:notion", "ntn_keychain_secret_8812");
    return withComputer(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        const { repos, projectId } = yield* simpleProject("c9");
        const needles = [
          "ntn_keychain_secret_8812",
          "claude-oauth-secret-5521",
          "codex-auth-secret-7734",
          "server-secret-file-9150",
          "session-secret-4471",
          "pairing-secret-3308",
          "environment-secret-6620",
          "ignored-dotenv-secret-1193",
          "setup-script-command-2207",
          "scheduled-prompt-8846",
        ];
        // Provider homes, the secrets directory and the ignored .env all hold a needle.
        write(config.baseDir, "providers/claude/.credentials.json", `{"t":"${needles[1]}"}`);
        write(config.baseDir, "providers/codex/auth.json", `{"t":"${needles[2]}"}`);
        write(config.secretsDir, "server-signing-key", needles[3]!);
        yield* sql`
          INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
          VALUES (${needles[4]!}, 'subject', '[]', 'browser-session-cookie', 'now', 'later')
        `;
        yield* sql`
          INSERT INTO auth_pairing_links (id, credential, method, scopes, subject, created_at,
            expires_at)
          VALUES ('pairing', ${needles[5]!}, 'one-time-token', '[]', 'subject', 'now', 'later')
        `;
        process.env.HOUSTON_TEST_SECRET = needles[6];
        write(repos.checkout, ".gitignore", ".env\n");
        commitAll(repos.checkout, "ignore .env");
        write(repos.checkout, ".env", `TOKEN=${needles[7]}\n`);
        const projects = yield* ProjectService.ProjectService;
        yield* projects.update({
          commandId: CommandId.make("command:transfer-test:scripts"),
          projectId,
          scripts: [
            {
              id: "setup",
              name: "Setup",
              command: needles[8]!,
              icon: "play",
              runOnWorktreeCreate: true,
            },
          ],
        });
        yield* sql`
          INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json, project_id,
            thread_id, workspace_strategy_json, model_selection_json, runtime_mode,
            interaction_mode, created_by, creation_source, created_at, updated_at, next_run_at,
            last_run_at, last_run_status, last_run_error, run_count)
          VALUES ('scheduled', 'Nightly', ${needles[9]!}, 1, '{}', ${projectId}, NULL, '{}', '{}',
            'full-access', 'default', 'user', 'web', 'now', 'now', NULL, NULL, 'never', NULL, 0)
        `;
        const sessions = yield* sql<{ readonly n: number }>`
          SELECT count(*) AS n FROM auth_sessions
        `;
        const pairings = yield* sql<{ readonly n: number }>`
          SELECT count(*) AS n FROM auth_pairing_links
        `;
        assert.strictEqual(sessions[0]!.n + pairings[0]!.n, 2, "both auth rows exist");

        try {
          const summary = yield* exportProject(projectId, destinationIn(repos.root));
          const frames = yield* framesOf(summary.file);
          const plain = Buffer.concat(
            frames.flatMap((frame) => [Buffer.from(frame.name), frame.bytes]),
          );
          for (const needle of needles) assert.isFalse(plain.includes(needle), needle);
          for (const name of [".credentials.json", "auth.json", "secrets/", "Nightly", "Setup"]) {
            assert.isFalse(plain.includes(name), name);
          }
          assert.isFalse(frames.some((frame) => frame.name.endsWith(".env")));
          // The export never asked the keychain for anything.
          assert.deepEqual(keychain.calls, []);
        } finally {
          delete process.env.HOUSTON_TEST_SECRET;
        }
      }),
      { keychain },
    );
  });
});

describe("export carries only this project's section rows", () => {
  it.effect("export carries only this project's section rows", () =>
    withComputer(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const a = yield* simpleProject("c10-a");
        const b = yield* simpleProject("c10-b");
        const seed = (projectId: string, label: string, number: number, root: string) =>
          Effect.gen(function* () {
            const taskId = yield* insertTask(projectId, number, `${label} task`);
            yield* sql`INSERT INTO houston_task_comments (task_id, body, author, created_at)
              VALUES (${taskId}, ${`${label} comment`}, 'user', 'now')`;
            yield* sql`INSERT INTO houston_task_history (task_id, actor, action, changes, created_at)
              VALUES (${taskId}, 'user', 'created', ${`{"note":"${label} history"}`}, 'now')`;
            yield* sql`INSERT INTO houston_task_acceptance (task_id, position, text)
              VALUES (${taskId}, 0, ${`${label} acceptance`})`;
            yield* sql`INSERT INTO houston_task_runs (task_id, attempt, kind, state, provider,
                initial_revision, started_at, summary)
              VALUES (${taskId}, 1, 'work', 'done', 'codex', 1, 'now', ${`${label} run`})`;
            yield* sql`INSERT INTO houston_task_initiatives (project_id, name, updated_at)
              VALUES (${projectId}, ${`${label} initiative`}, 'now')`;
            yield* sql`INSERT INTO houston_task_settings (project_id, access, start_model, delivery,
                focus, rework_rounds, updated_at)
              VALUES (${projectId}, 'full', '{}', ${`${label} delivery`}, 'focus', 1, 'now')`;
            yield* sql`INSERT INTO houston_task_source_settings (project_id, provider, enabled,
                settings_json, updated_at)
              VALUES (${projectId}, 'github_issues', 1, ${`{"label":"${label} source"}`}, 'now')`;
            yield* sql`INSERT INTO houston_task_source_links (task_id, project_id, provider,
                external_id, source, url, snapshot_json, sync_state_json)
              VALUES (${taskId}, ${projectId}, 'github_issues', ${`o/r#${number}`}, 'source',
                ${`https://github.com/o/r/issues/${number}`}, ${`{"t":"${label} link"}`}, '{}')`;
            yield* sql`INSERT INTO houston_task_source_poll (project_id, provider, cursor_json)
              VALUES (${projectId}, 'github_issues', ${`{"c":"${label} poll"}`})`;
            yield* sql`INSERT INTO houston_task_source_outbox (project_id, task_id, provider, action,
                revision, payload_json, next_attempt_at)
              VALUES (${projectId}, ${taskId}, 'github_issues', 'update', 1,
                ${`{"p":"${label} outbox"}`}, 'now')`;
            yield* sql`INSERT INTO houston_task_source_credentials (project_id, provider)
              VALUES (${projectId}, 'notion')`;
            yield* sql`INSERT INTO houston_review_files_viewed (worktree_root, ref_name, path, blob,
                viewed_at)
              VALUES (${root}, 'main', ${`${label}-viewed.ts`}, 'blob', 'now')`;
            yield* sql`INSERT INTO houston_review_files_viewed (worktree_root, ref_name, path, blob,
                viewed_at)
              VALUES (${NodePath.join(root, "..", "elsewhere")}, 'main',
                ${`${label}-elsewhere.ts`}, 'blob', 'now')`;
          });
        yield* seed(a.projectId, "alpha", 1, a.repos.checkout);
        yield* seed(b.projectId, "bravo", 2, b.repos.checkout);
        yield* sql`INSERT OR REPLACE INTO houston_task_source_identity (id, namespace)
          VALUES (1, 'identity-namespace')`;
        yield* sql`UPDATE houston_task_counter SET next_number = 977`;

        const summary = yield* exportProject(a.projectId, destinationIn(a.repos.root));
        const frames = yield* framesOf(summary.file);
        const sections = frames
          .filter((frame) => frame.name.startsWith("sections/"))
          .map((frame) => Buffer.from(frame.bytes).toString("utf8"))
          .join("\n");
        for (const kept of [
          "alpha task",
          "alpha comment",
          "alpha history",
          "alpha acceptance",
          "alpha run",
          "alpha initiative",
          "alpha delivery",
          "alpha source",
          "alpha link",
          "alpha-viewed.ts",
        ]) {
          assert.include(sections, kept);
        }
        for (const dropped of [
          "bravo",
          "alpha poll",
          "alpha outbox",
          "alpha-elsewhere.ts",
          "identity-namespace",
          "977",
          "houston_task_source_credentials",
          "houston_task_counter",
        ]) {
          assert.notInclude(sections, dropped);
        }
        assert.deepEqual(
          frames.filter((frame) => frame.name.startsWith("sections/")).map((frame) => frame.name),
          ["sections/tasks.json", "sections/taskSources.json", "sections/reviewFilesViewed.json"],
        );
      }),
    ),
  );
});

describe("the renderer string is carried unchanged and bounded", () => {
  it.effect("the renderer string is carried unchanged and bounded", () =>
    withComputer(
      Effect.gen(function* () {
        const { repos, projectId } = yield* simpleProject("c12");
        const head = '{"grid":"a\u0000b","name":"Ünïcødé ✓"}';
        const headBytes = Buffer.byteLength(head, "utf8");
        const renderer = head + "x".repeat(1_048_576 - headBytes);
        assert.strictEqual(Buffer.byteLength(renderer, "utf8"), 1_048_576);
        const summary = yield* exportProject(projectId, destinationIn(repos.root), { renderer });
        const manifest = manifestOf(yield* framesOf(summary.file));
        assert.isTrue(manifest.renderer === renderer, "the renderer string round-trips");

        const over = `${renderer}y`;
        const refusal = yield* refusalOf(
          exportProject(projectId, destinationIn(repos.root, "over"), { renderer: over }),
        );
        assert.strictEqual(refusal.kind, "limit");
        assert.strictEqual(refusal.limit, 1_048_576);
        assert.strictEqual(refusal.actual, 1_048_577);
      }),
    ),
  );
});

describe("export refuses an unknown project, a folder without git, nothing to carry and a running transfer", () => {
  it.effect(
    "export refuses an unknown project, a folder without git, nothing to carry and a running transfer",
    () =>
      withComputer(
        Effect.gen(function* () {
          const scratch = makeRepos("houston-transfer-c13-");
          const unknown = yield* refusalOf(
            exportProject(ProjectId.make("project-missing"), destinationIn(scratch.root)),
          );
          assert.strictEqual(unknown.kind, "not_found");
          assert.include(unknown.items, "project-missing");

          const plain = NodePath.join(scratch.root, "plain-folder");
          NodeFS.mkdirSync(plain);
          const plainProject = yield* createProject("c13-plain", plain);
          yield* seedThread({ threadId: "t-c13-plain", projectId: plainProject, title: "Plain" });
          const noGit = yield* refusalOf(exportProject(plainProject, destinationIn(scratch.root)));
          assert.strictEqual(noGit.kind, "not_git_repository");
          assert.include(noGit.items, plain);

          const empty = yield* createProject("c13-empty", scratch.checkout);
          const nothing = yield* refusalOf(exportProject(empty, destinationIn(scratch.root)));
          assert.strictEqual(nothing.kind, "nothing_to_transfer");

          // A second export of the same project while the first is held at packing.
          const { repos, projectId } = yield* simpleProject("c13-busy");
          const reached = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const first = yield* exportProject(projectId, destinationIn(repos.root, "first")).pipe(
            Effect.provideService(TransferProbe, {
              ...TransferProbe.defaultValue(),
              onStage: (_operation, stage) =>
                stage === "packing"
                  ? Deferred.succeed(reached, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    )
                  : Effect.void,
            }),
            Effect.forkScoped,
          );
          yield* Deferred.await(reached);
          const busy = yield* refusalOf(
            exportProject(projectId, destinationIn(repos.root, "second")),
          );
          assert.strictEqual(busy.kind, "busy");
          assert.include(busy.problem, "export");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          // The slot is free again.
          yield* exportProject(projectId, destinationIn(repos.root, "third"));
        }),
      ),
  );
});
