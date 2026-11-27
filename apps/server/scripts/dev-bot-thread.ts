#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off globalConsole:off globalConsoleInEffect:off globalDateInEffect:off preferSchemaOverJson:off - A development tool that talks to a running dev server.
// Records a bot and one bot run, then launches its thread as a client would, so bot-thread rules
// can be tried on a real provider in a named development channel. See USAGE.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as EffectNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  MessageId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WsRpcGroup,
} from "@houston-app/contracts";
import type { HoustonBotRunKind } from "@houston-app/contracts/houston/bots";
import * as NetService from "@houston-app/shared/Net";
import * as NodeSqliteClient from "@houston-app/shared/nodeSqliteClient";
import type { ReleaseChannel } from "@houston-app/shared/releaseResource";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import { resolveCliAuthConfig } from "../src/cli/config.ts";
import * as ServerConfig from "../src/config.ts";
import { insertBotRun } from "../src/houston/bots/botRuns.ts";
import { policyFor } from "../src/houston/bots/kinds.ts";

const USAGE = `Usage:
  node scripts/dev-bot-thread.ts start --channel <dev channel> --kind asked|unattended
    --project <project id> --account <Claude instance id> --model <model> --prompt <text>
    [--name <bot name>] [--instructions <text>] [--base-ref <branch>] [--full-access]
  node scripts/dev-bot-thread.ts resume --channel <dev channel> --bot-run <id> --prompt <text>`;

const CHANNEL_NAME = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

/** The base directory of a named development channel, or why the script refuses it. */
export function devChannelBaseDir(input: {
  readonly channel: string;
  readonly home: string;
  readonly build: ReleaseChannel;
}): { readonly baseDir: string } | { readonly refusal: string } {
  if (input.build !== "dev") {
    return {
      refusal: `This build reports channel "${input.build}"; the script runs only from source.`,
    };
  }
  if (input.channel === "release" || !CHANNEL_NAME.test(input.channel)) {
    return {
      refusal: `"${input.channel}" is not a development channel. Expected 1-32 of [a-z0-9-], not "release".`,
    };
  }
  const baseDir = NodePath.join(input.home, `.houston-${input.channel}`, "v2");
  const installed = NodePath.join(input.home, ".houston");
  return baseDir === installed || baseDir.startsWith(`${installed}${NodePath.sep}`)
    ? { refusal: `Refusing ${baseDir}: it is the installed channel's state.` }
    : { baseDir };
}

export interface ProofBot {
  readonly botId: string;
  readonly botRunId: string;
  readonly threadId: string;
  readonly kind: HoustonBotRunKind;
  readonly name: string;
  readonly projectId: string;
  readonly account: string;
  readonly model: string;
  readonly fullAccess: boolean;
  readonly instructions: string;
  readonly at: string;
}

const PROOF_ACTOR = { sessionId: "dev-bot-thread", label: "dev-bot-thread script" };

/** Records a bot that is switched off (nothing else may start it) and one bot run of it. */
export const recordProofBot = Effect.fn("devBotThread.record")(function* (bot: ProofBot) {
  const sql = yield* SqlClient.SqlClient;
  const sha256 = NodeCrypto.createHash("sha256").update(bot.instructions, "utf8").digest("hex");
  const policy = policyFor({
    kind: bot.kind,
    bot: { askedMode: "auto", unattendedFullAccess: bot.fullAccess, maxMinutes: 20 },
  });
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO houston_bots (
          id, slug, name, mark, job, default_project_id, other_project_ids_json,
          model_selection_json, asked_mode, unattended_full_access, enabled, row_revision,
          created_at, updated_at
        ) VALUES (
          ${bot.botId}, ${`proof-${bot.botId.slice(0, 8)}`}, ${bot.name}, '🧪',
          'Proves the run policy of bot threads', ${bot.projectId}, '[]',
          ${JSON.stringify({ instanceId: bot.account, model: bot.model })}, 'auto',
          ${bot.fullAccess ? 1 : 0}, 0, 1, ${bot.at}, ${bot.at}
        )
      `;
      yield* sql`
        INSERT INTO houston_bot_revisions (
          bot_id, n, text, sha256, accepted_at, accepted_by_session, accepted_by_label
        ) VALUES (
          ${bot.botId}, 1, ${bot.instructions}, ${sha256}, ${bot.at}, ${PROOF_ACTOR.sessionId},
          ${PROOF_ACTOR.label}
        )
      `;
      yield* insertBotRun({
        id: bot.botRunId,
        botId: bot.botId,
        botName: bot.name,
        kind: bot.kind,
        origin: bot.kind === "asked" ? "owner" : "test",
        projectId: bot.projectId,
        threadId: bot.threadId,
        revisionN: 1,
        revisionSha256: sha256,
        template: "dev-bot-thread",
        policy,
        startedAt: bot.at,
      });
    }),
  );
  return policy;
});

/** What `orchestration.launchThread` is sent: an unattended bot run works in a new worktree. */
export function proofLaunchInput(
  bot: ProofBot,
  input: { readonly prompt: string; readonly baseRef: string },
) {
  const policy = policyFor({
    kind: bot.kind,
    bot: { askedMode: "auto", unattendedFullAccess: bot.fullAccess, maxMinutes: 20 },
  });
  return {
    commandId: CommandId.make(`houston-bot-run:${bot.botRunId}`),
    threadId: ThreadId.make(bot.threadId),
    projectId: ProjectId.make(bot.projectId),
    title: `${bot.name} · ${input.prompt.split("\n")[0]?.slice(0, 60) ?? "proof"}`,
    modelSelection: { instanceId: ProviderInstanceId.make(bot.account), model: bot.model },
    runtimeMode: policy.runtimeMode ?? ("auto" as const),
    interactionMode: "default" as const,
    workspaceStrategy:
      bot.kind === "unattended"
        ? ({ type: "worktree", baseRef: input.baseRef } as const)
        : ({ type: "root" } as const),
    initialMessage: {
      messageId: MessageId.make(`bot-run:${bot.botRunId}`),
      text: input.prompt,
      attachments: [],
    },
  };
}

const decodeRuntimeFile = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ origin: Schema.String })),
);
const decodeTicket = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }));

/** A client session of the channel's own server, and a socket to it. */
const connect = Effect.fn("devBotThread.connect")(function* (baseDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const runtimePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
  const runtime = decodeRuntimeFile(yield* fs.readFileString(runtimePath));
  const config = yield* resolveCliAuthConfig(
    { baseDir: Option.some(baseDir), devUrl: Option.none() },
    Option.none(),
    { quietLogs: true },
  );
  const issued = yield* Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* auth.issueSession({
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      label: PROOF_ACTOR.label,
    });
  }).pipe(
    Effect.provide(EnvironmentAuth.layerRuntime.pipe(Layer.provide(ServerConfig.layer(config)))),
  );
  const ticket = yield* Effect.promise(async () => {
    const response = await fetch(`${runtime.origin}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issued.token}`,
        [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
      },
    });
    if (!response.ok) throw new Error(`The socket ticket was refused: ${response.status}`);
    return decodeTicket(await response.json());
  });
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(
        `${runtime.origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
      ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );
});

const databaseOf = (baseDir: string) =>
  NodeSqliteClient.layer({ filename: NodePath.join(baseDir, "userdata", "statev2.sqlite") });

const start = Effect.fn("devBotThread.start")(function* (
  baseDir: string,
  values: Record<string, string | boolean | undefined>,
) {
  const required = (name: string) => {
    const value = values[name];
    if (typeof value !== "string" || value.length === 0) throw new Error(`--${name} is required.`);
    return value;
  };
  const kind = required("kind");
  if (kind !== "asked" && kind !== "unattended") {
    throw new Error(`--kind is "${kind}"; expected asked or unattended.`);
  }
  const bot: ProofBot = {
    botId: NodeCrypto.randomUUID(),
    botRunId: NodeCrypto.randomUUID(),
    threadId: NodeCrypto.randomUUID(),
    kind,
    name: typeof values["name"] === "string" ? values["name"] : "Proof bot",
    projectId: required("project"),
    account: required("account"),
    model: required("model"),
    fullAccess: values["full-access"] === true,
    instructions:
      typeof values["instructions"] === "string"
        ? values["instructions"]
        : "You prove Houston's rules for bot threads. Do what the owner's message asks and report what happened.",
    at: new Date().toISOString(),
  };
  const prompt = required("prompt");
  yield* recordProofBot(bot).pipe(Effect.provide(databaseOf(baseDir)));
  const protocol = yield* connect(baseDir);
  const launch = proofLaunchInput(bot, {
    prompt,
    baseRef: typeof values["base-ref"] === "string" ? values["base-ref"] : "main",
  });
  yield* Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    yield* client["orchestration.launchThread"](launch);
  }).pipe(Effect.scoped, Effect.provide(protocol));
  console.log(JSON.stringify({ botRunId: bot.botRunId, threadId: bot.threadId, kind }));
});

const resume = Effect.fn("devBotThread.resume")(function* (
  baseDir: string,
  values: Record<string, string | boolean | undefined>,
) {
  const botRunId = values["bot-run"];
  const prompt = values["prompt"];
  if (typeof botRunId !== "string" || typeof prompt !== "string") {
    throw new Error("--bot-run and --prompt are required.");
  }
  const rows = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM houston_bot_runs WHERE id = ${botRunId}
    `;
  }).pipe(Effect.provide(databaseOf(baseDir)));
  const threadId = rows[0]?.thread_id;
  if (threadId === undefined) throw new Error(`No bot run ${botRunId} in ${baseDir}.`);
  const protocol = yield* connect(baseDir);
  yield* Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    yield* client["orchestration.dispatchCommand"]({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      threadId: ThreadId.make(threadId),
      messageId: MessageId.make(NodeCrypto.randomUUID()),
      text: prompt,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
    });
  }).pipe(Effect.scoped, Effect.provide(protocol));
  console.log(JSON.stringify({ botRunId, threadId, resumed: true }));
});

if (import.meta.main) {
  const { positionals, values } = NodeUtil.parseArgs({
    allowPositionals: true,
    options: {
      channel: { type: "string" },
      kind: { type: "string" },
      project: { type: "string" },
      account: { type: "string" },
      model: { type: "string" },
      prompt: { type: "string" },
      name: { type: "string" },
      instructions: { type: "string" },
      "base-ref": { type: "string" },
      "full-access": { type: "boolean" },
      "bot-run": { type: "string" },
    },
  });
  const target = devChannelBaseDir({
    channel: values.channel ?? "",
    home: NodeOS.homedir(),
    build: ServerConfig.telemetryChannel,
  });
  if ("refusal" in target) {
    console.error(target.refusal);
    process.exit(1);
  }
  const command = positionals[0];
  const program = Effect.gen(function* () {
    if (command === "start") return yield* start(target.baseDir, values);
    if (command === "resume") return yield* resume(target.baseDir, values);
    return yield* Effect.die(new Error(`Unknown command "${command ?? ""}".\n${USAGE}`));
  });
  Effect.runPromise(
    program.pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, EffectNodeCrypto.layer, NetService.layer)),
    ),
  ).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
