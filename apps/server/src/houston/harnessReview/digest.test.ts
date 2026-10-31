// @effect-diagnostics nodeBuiltinImport:off - reads the digest module's own source.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { buildDigest, type DigestThreadInput, DIGEST_LIMITS } from "./digest.ts";

const P = ProjectId.make("project-p");
const Q = ProjectId.make("project-q");
const WINDOW = {
  sinceMs: Date.parse("2026-10-16T09:00:00.000Z"),
  untilMs: Date.parse("2026-10-30T09:00:00.000Z"),
};
const at = (iso: string) => DateTime.makeUnsafe(iso);

let itemOrdinal = 0;

const thread = (
  id: string,
  overrides: Partial<DigestThreadInput["thread"]> = {},
): DigestThreadInput["thread"] => ({
  id: ThreadId.make(id),
  projectId: P,
  title: `Thread ${id}`,
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  modelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-sonnet-4-6",
  },
  lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
  creationSource: "web",
  createdBy: "user",
  deletedAt: null,
  forkedFrom: null,
  createdAt: at("2026-10-01T00:00:00.000Z"),
  ...overrides,
});

const run = (
  threadId: string,
  ordinal: number,
  startedAt: string,
  instance = "claudeAgent",
): OrchestrationV2Run =>
  ({
    id: RunId.make(`run:${threadId}:${ordinal}`),
    threadId: ThreadId.make(threadId),
    ordinal,
    providerInstanceId: ProviderInstanceId.make(instance),
    modelSelection: { instanceId: ProviderInstanceId.make(instance), model: `${instance}-model` },
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${threadId}:${ordinal}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: at(startedAt),
    startedAt: at(startedAt),
    completedAt: at(startedAt),
    checkpointId: null,
    contextHandoffId: null,
  }) as OrchestrationV2Run;

const item = (
  threadId: string,
  runId: RunId,
  time: string,
  fields: Record<string, unknown>,
): OrchestrationV2TurnItem => {
  itemOrdinal += 1;
  return {
    id: TurnItemId.make(`item:${itemOrdinal}`),
    threadId: ThreadId.make(threadId),
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: itemOrdinal,
    status: "completed",
    title: null,
    startedAt: at(time),
    completedAt: at(time),
    updatedAt: at(time),
    ...fields,
  } as OrchestrationV2TurnItem;
};

const userMessage = (
  threadId: string,
  runId: RunId,
  time: string,
  text: string,
  extra: Record<string, unknown> = {},
) =>
  item(threadId, runId, time, {
    type: "user_message",
    createdBy: "user",
    creationSource: "web",
    messageId: MessageId.make(`message:${itemOrdinal + 1}`),
    inputIntent: "message",
    text,
    attachments: [],
    ...extra,
  });

const command = (
  threadId: string,
  runId: RunId,
  time: string,
  input: string,
  extra: Record<string, unknown> = {},
) => item(threadId, runId, time, { type: "command_execution", input, ...extra });

const input = (
  shell: DigestThreadInput["thread"],
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  taskKey: string | null = null,
): DigestThreadInput => ({ thread: shell, runs, turnItems, taskKey });

const parseLines = (jsonl: string) =>
  jsonl
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);

/** Project P's threads in and around the window, plus one of project Q. */
const fixture = (): ReadonlyArray<DigestThreadInput> => {
  const claudeRun = run("t-claude", 1, "2026-10-28T10:00:00.000Z");
  const forkRun = run("t-fork", 1, "2026-10-29T10:00:00.000Z");
  const codexRun = run("t-codex", 1, "2026-10-27T10:00:00.000Z", "codex");
  const opencodeRun = run("t-opencode", 1, "2026-10-26T10:00:00.000Z", "opencode");
  const taskRun = run("t-task", 1, "2026-10-25T10:00:00.000Z");
  const t = (day: string, hour = "10") => `2026-10-${day}T${hour}:30:00.000Z`;
  return [
    input(
      thread("t-claude"),
      [claudeRun],
      [
        userMessage("t-claude", claudeRun.id, t("28"), "Fix the build"),
        userMessage("t-claude", claudeRun.id, t("28", "11"), "and also lint", {
          delivery: { type: "queued" },
        }),
        userMessage("t-claude", claudeRun.id, t("28", "11"), "Scheduled check", {
          scheduledTaskId: "scheduled-task:1",
          createdBy: "system",
          creationSource: "server",
        }),
        userMessage("t-claude", claudeRun.id, t("28", "11"), "Message from a sibling", {
          senderThreadId: "t-codex",
          createdBy: "agent",
          creationSource: "mcp",
        }),
        command("t-claude", claudeRun.id, t("28", "12"), "pnpm build", { status: "failed" }),
        command("t-claude", claudeRun.id, t("28", "12"), "pnpm lint", { exitCode: 2 }),
        command("t-claude", claudeRun.id, t("28", "12"), "pnpm test", {
          outputIndicatesFailure: true,
        }),
        command("t-claude", claudeRun.id, t("28", "12"), "pnpm format", { exitCode: 0 }),
        item("t-claude", claudeRun.id, t("28", "13"), {
          type: "approval_request",
          requestId: "request:1",
          requestKind: "command",
          prompt: "git push origin main",
          reason: "pushes to the remote",
          status: "failed",
        }),
        item("t-claude", claudeRun.id, t("28", "13"), {
          type: "approval_request",
          requestId: "request:2",
          requestKind: "file-change",
          prompt: "edit secrets.env",
          reason: "writes outside the workspace",
          status: "cancelled",
        }),
        item("t-claude", claudeRun.id, t("28", "13"), {
          type: "approval_request",
          requestId: "request:3",
          requestKind: "command",
          prompt: "ls",
          status: "completed",
        }),
        item("t-claude", claudeRun.id, t("28", "14"), {
          type: "run_interrupt_request",
          message: "Stop",
        }),
        item("t-claude", claudeRun.id, t("28", "14"), {
          type: "compaction",
          driver: "claudeAgent",
        }),
        item("t-claude", claudeRun.id, t("28", "14"), {
          type: "error",
          failure: { class: "provider", message: "Rate limited", code: null, retryable: true },
        }),
        item("t-claude", claudeRun.id, t("28", "15"), {
          type: "subagent",
          subagentId: "node:sub",
          origin: "provider_native",
          driver: "claudeAgent",
          providerInstanceId: "claudeAgent",
          childThreadId: null,
          prompt: "Search the repository for the config",
          result: null,
        }),
        item("t-claude", claudeRun.id, t("28", "16"), {
          type: "assistant_message",
          messageId: "assistant:1",
          text: "First answer",
          streaming: false,
        }),
        item("t-claude", claudeRun.id, t("28", "17"), {
          type: "assistant_message",
          messageId: "assistant:2",
          text: "Done: the build passes.",
          streaming: false,
        }),
      ],
    ),
    // A fork of t-claude: its projection repeats the source's run items, which are not its own.
    input(
      thread("t-fork", {
        lineage: {
          rootThreadId: ThreadId.make("t-claude"),
          parentThreadId: ThreadId.make("t-claude"),
          relationshipToParent: "fork",
        },
        forkedFrom: { type: "run", threadId: ThreadId.make("t-claude"), runId: claudeRun.id },
      }),
      [forkRun],
      [
        userMessage("t-fork", claudeRun.id, t("28"), "Fix the build"),
        userMessage("t-fork", forkRun.id, t("29"), "Try another approach"),
      ],
    ),
    input(
      thread("t-codex", { providerInstanceId: ProviderInstanceId.make("codex") }),
      [codexRun],
      [userMessage("t-codex", codexRun.id, t("27"), "Codex prompt")],
    ),
    input(
      thread("t-opencode", { providerInstanceId: ProviderInstanceId.make("opencode") }),
      [opencodeRun],
      [
        userMessage("t-opencode", opencodeRun.id, t("26"), "p".repeat(5_000)),
        command("t-opencode", opencodeRun.id, t("26"), "c".repeat(1_000), { exitCode: 1 }),
      ],
    ),
    input(
      thread("t-task"),
      [taskRun],
      [userMessage("t-task", taskRun.id, t("25"), "Work on HOU-4")],
      "HOU-4",
    ),
    input(
      thread("t-deleted", { deletedAt: at("2026-10-29T00:00:00.000Z") }),
      [run("t-deleted", 1, "2026-10-28T09:00:00.000Z")],
      [],
    ),
    input(
      thread("t-review", { side: { kind: "harnessReview", reviewId: 2 } }),
      [run("t-review", 1, "2026-10-28T09:00:00.000Z")],
      [],
    ),
    input(
      thread("t-subagent", {
        lineage: {
          rootThreadId: ThreadId.make("t-claude"),
          parentThreadId: ThreadId.make("t-claude"),
          relationshipToParent: "subagent",
        },
        creationSource: "provider",
      }),
      [run("t-subagent", 1, "2026-10-28T09:00:00.000Z")],
      [],
    ),
    input(
      thread("t-old"),
      [run("t-old", 1, "2026-10-01T09:00:00.000Z")],
      [userMessage("t-old", RunId.make("run:t-old:1"), "2026-10-01T09:30:00.000Z", "Old")],
    ),
    input(thread("t-q", { projectId: Q }), [run("t-q", 1, "2026-10-28T09:00:00.000Z")], []),
  ];
};

describe("the digest", () => {
  it("the digest holds one line per thread of the project in the window", () => {
    const digest = buildDigest({
      projectId: P,
      window: WINDOW,
      previousEnd: null,
      threads: fixture(),
    });
    const lines = parseLines(digest.jsonl);
    assert.deepEqual(
      lines.map((line) => line.thread),
      ["t-fork", "t-claude", "t-codex", "t-opencode", "t-task"],
    );
    const byId = new Map(lines.map((line) => [line.thread, line]));
    const claude = byId.get("t-claude")!;
    assert.equal(claude.title, "Thread t-claude");
    assert.equal(claude.provider, "claudeAgent");
    assert.equal(claude.started, "2026-10-28T10:00:00.000Z");
    assert.isUndefined(claude.task);
    assert.deepEqual(claude.prompts, ["Fix the build", "and also lint"]);
    assert.equal(claude.automatic, 2);
    assert.deepEqual(
      claude.failures.map((failure: { command: string }) => failure.command),
      ["pnpm build", "pnpm lint", "pnpm test"],
    );
    assert.deepEqual(
      claude.approvals.map((approval: Record<string, string>) => [
        approval.prompt,
        approval.reason,
        approval.status,
      ]),
      [
        ["git push origin main", "pushes to the remote", "failed"],
        ["edit secrets.env", "writes outside the workspace", "cancelled"],
      ],
    );
    assert.equal(claude.interrupts, 1);
    assert.equal(claude.compactions, 1);
    assert.deepEqual(claude.errors, ["Rate limited"]);
    assert.deepEqual(claude.subagents, ["Search the repository for the config"]);
    assert.equal(claude.tools.command, 4);
    assert.equal(claude.last_assistant, "Done: the build passes.");

    assert.equal(byId.get("t-task")!.task, "HOU-4");
    assert.equal(byId.get("t-codex")!.provider, "codex");
    assert.deepEqual(byId.get("t-fork")!.prompts, ["Try another approach"]);
    const opencode = byId.get("t-opencode")!;
    assert.lengthOf(opencode.prompts[0], 2_000 + 1);
    assert.lengthOf(opencode.failures[0].command, 300 + 1);

    assert.equal(digest.meta.threadsWritten, 5);
    assert.equal(digest.meta.skipped.outsideWindow, 1);
    assert.equal(digest.meta.skipped.deleted, 1);
    assert.equal(digest.meta.skipped.harnessReview, 1);
    assert.equal(digest.meta.skipped.subagent, 1);
    assert.equal(digest.meta.window.since, "2026-10-16T09:00:00.000Z");
    assert.equal(digest.meta.window.until, "2026-10-30T09:00:00.000Z");
  });

  it.effect("the digest reads no cli transcript", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "harness-digest-home-" });
      const before = buildDigest({
        projectId: P,
        window: WINDOW,
        previousEnd: null,
        threads: fixture(),
      });
      for (const [relative, line] of [
        [".claude/projects/p/x.jsonl", { cwd: "/work/p", type: "user", message: "transcript" }],
        [".codex/sessions/2026/r.jsonl", { cwd: "/work/p", payload: "transcript" }],
      ] as const) {
        const target = path.join(home, ...relative.split("/"));
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFileString(target, `${JSON.stringify(line)}\n`);
      }
      const reads: string[] = [];
      const spy = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFile: (file) => {
            reads.push(file);
            return Effect.succeed(new Uint8Array());
          },
          readFileString: (file) => {
            reads.push(file);
            return Effect.succeed("");
          },
          readDirectory: (file) => {
            reads.push(file);
            return Effect.succeed([]);
          },
        }),
      );
      const after = yield* Effect.sync(() =>
        buildDigest({ projectId: P, window: WINDOW, previousEnd: null, threads: fixture() }),
      ).pipe(Effect.provide(spy));
      assert.equal(after.jsonl, before.jsonl);
      assert.deepEqual(after.meta, before.meta);
      assert.deepEqual(reads, []);
      // The builder holds no file access at all: nothing in it can open a transcript.
      const source = NodeFS.readFileSync(new URL("./digest.ts", import.meta.url), "utf8");
      for (const forbidden of ["FileSystem", "node:fs", ".claude", ".codex", "homedir"]) {
        assert.notInclude(source, forbidden, forbidden);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("digest texts are masked", () => {
    const claudeRun = run("t-mask", 1, "2026-10-28T10:00:00.000Z");
    const time = "2026-10-28T10:30:00.000Z";
    const digest = buildDigest({
      projectId: P,
      window: WINDOW,
      previousEnd: null,
      threads: [
        input(
          thread("t-mask", { title: "Rotate API_KEY=title-secret" }),
          [claudeRun],
          [
            userMessage(
              "t-mask",
              claudeRun.id,
              time,
              `Use GITHUB_TOKEN=ghp_${"a".repeat(36)} for the push`,
            ),
            command(
              "t-mask",
              claudeRun.id,
              time,
              'curl -H "Authorization: Bearer abc.def" https://api.example.com',
              { exitCode: 22 },
            ),
            item("t-mask", claudeRun.id, time, {
              type: "error",
              failure: {
                class: "provider",
                message: "Could not open /work/p/src/index.ts",
                code: null,
                retryable: false,
              },
            }),
            item("t-mask", claudeRun.id, time, {
              type: "error",
              failure: {
                class: "provider",
                message: "Refused SECRET_KEY=error-secret",
                code: null,
                retryable: false,
              },
            }),
            item("t-mask", claudeRun.id, time, {
              type: "approval_request",
              requestId: "request:mask",
              requestKind: "command",
              prompt: 'curl -H "Authorization: Bearer approval.secret"',
              reason: "needs PASSWORD=reason-secret",
              status: "failed",
            }),
            item("t-mask", claudeRun.id, time, {
              type: "subagent",
              prompt: "Deploy with AUTH_TOKEN=subagent-secret",
            }),
            item("t-mask", claudeRun.id, time, {
              type: "assistant_message",
              text: "Done; I used ACCESS_TOKEN=assistant-secret",
            }),
          ],
        ),
      ],
    });
    const [line] = parseLines(digest.jsonl);
    assert.include(line!.prompts[0], "GITHUB_TOKEN=<redacted>");
    assert.notInclude(digest.jsonl, "ghp_");
    assert.include(line!.failures[0].command, "Bearer <redacted>");
    assert.notInclude(digest.jsonl, "abc.def");
    assert.deepEqual(line!.errors, [
      "Could not open /work/p/src/index.ts",
      "Refused SECRET_KEY=<redacted>",
    ]);
    assert.equal(line!.title, "Rotate API_KEY=<redacted>");
    assert.deepEqual(line!.approvals, [
      {
        kind: "command",
        prompt: 'curl -H "Authorization: Bearer <redacted>"',
        reason: "needs PASSWORD=<redacted>",
        status: "failed",
      },
    ]);
    assert.deepEqual(line!.subagents, ["Deploy with AUTH_TOKEN=<redacted>"]);
    assert.equal(line!.last_assistant, "Done; I used ACCESS_TOKEN=<redacted>");
    assert.notMatch(digest.jsonl, /-secret|approval\.secret/);
  });

  it("digest masking covers header, password and json credentials", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["Authorization: Basic dXNlcjpwYXNz", "Authorization: Basic <redacted>", "dXNlcjpwYXNz"],
      ["curl -H 'X-Api-Key: abc123'", "curl -H 'X-Api-Key: <redacted>'", "abc123"],
      ["password: hunter2", "password: <redacted>", "hunter2"],
      ["password=hunter2", "password=<redacted>", "hunter2"],
      ['{"token": "abc123"}', '{"token": "<redacted>"}', "abc123"],
      ['{"password": "pw-123"}', '{"password": "<redacted>"}', "pw-123"],
      ['{"access_token": "at-456"}', '{"access_token": "<redacted>"}', "at-456"],
      [
        "Worker 12 asked once; request 12345678 took 3 attempts.",
        "Worker 12 asked once; request 12345678 took 3 attempts.",
        "<redacted>",
      ],
    ];
    const credentialRun = run("t-credentials", 1, "2026-10-28T10:00:00.000Z");
    const digest = buildDigest({
      projectId: P,
      window: WINDOW,
      previousEnd: null,
      threads: [
        input(
          thread("t-credentials"),
          [credentialRun],
          cases.map(([text], index) =>
            userMessage(
              "t-credentials",
              credentialRun.id,
              `2026-10-28T10:${String(10 + index)}:00.000Z`,
              text,
            ),
          ),
        ),
      ],
    });
    const [line] = parseLines(digest.jsonl);
    cases.forEach(([text, expected, gone], index) => {
      assert.equal(line!.prompts[index], expected, text);
      assert.notInclude(line!.prompts[index], gone, text);
    });
  });

  it("a digest line and the digest stay within their caps", () => {
    const bigRun = run("t-big", 1, "2026-10-28T10:00:00.000Z");
    const minute = (index: number) =>
      DateTime.formatIso(
        DateTime.makeUnsafe(Date.parse("2026-10-28T10:00:00.000Z") + index * 60_000),
      );
    const big: OrchestrationV2TurnItem[] = [];
    for (let index = 0; index < 40; index += 1) {
      big.push(userMessage("t-big", bigRun.id, minute(index), `${index}:${"p".repeat(1_990)}`));
    }
    for (let index = 0; index < 4; index += 1) {
      big.push(command("t-big", bigRun.id, minute(40 + index), `fail-${index}`, { exitCode: 1 }));
    }
    const one = buildDigest({
      projectId: P,
      window: WINDOW,
      previousEnd: "2026-10-16T09:00:00.000Z",
      threads: [input(thread("t-big"), [bigRun], big)],
    });
    const [bigLine] = one.jsonl.split("\n").filter((line) => line.length > 0);
    assert.isAtMost(Buffer.byteLength(bigLine!), DIGEST_LIMITS.lineBytes);
    assert.equal(DIGEST_LIMITS.lineBytes, 64 * 1024);
    const parsed = JSON.parse(bigLine!);
    assert.isAbove(parsed.truncated.prompts, 0);
    assert.equal(parsed.prompts.length + parsed.truncated.prompts, 40);
    assert.match(parsed.prompts.at(-1), /^39:/);
    assert.match(parsed.prompts[0], new RegExp(`^${parsed.truncated.prompts}:`));
    assert.lengthOf(parsed.failures, 4);
    assert.equal(one.meta.previousReviewEnd, "2026-10-16T09:00:00.000Z");

    const many: DigestThreadInput[] = [];
    for (let index = 0; index < 40; index += 1) {
      const id = `t-${String(index).padStart(2, "0")}`;
      const started = DateTime.formatIso(
        DateTime.makeUnsafe(Date.parse("2026-10-17T00:00:00.000Z") + index * 3_600_000),
      );
      const threadRun = run(id, 1, started);
      many.push(
        input(
          thread(id),
          [threadRun],
          Array.from({ length: 40 }, (_, prompt) =>
            userMessage(id, threadRun.id, started, `${prompt}:${"x".repeat(1_990)}`),
          ),
        ),
      );
    }
    const all = buildDigest({ projectId: P, window: WINDOW, previousEnd: null, threads: many });
    assert.isAtMost(Buffer.byteLength(all.jsonl), DIGEST_LIMITS.digestBytes);
    assert.equal(DIGEST_LIMITS.digestBytes, 2 * 1024 * 1024);
    const written = parseLines(all.jsonl).map((line) => line.thread);
    assert.equal(all.meta.threadsWritten, written.length);
    assert.equal(all.meta.threadsDropped, 40 - written.length);
    assert.isAbove(all.meta.threadsDropped, 0);
    // Newest first; the oldest threads are the ones left out.
    assert.equal(written[0], "t-39");
    assert.equal(written.at(-1), `t-${String(40 - written.length).padStart(2, "0")}`);
  });
});
