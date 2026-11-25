// Bots over one database, with stand-in projects and provider accounts.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ProviderInstanceId } from "@houston-app/contracts";
import type { HoustonBot, HoustonBotSaveInput } from "@houston-app/contracts/houston/bots";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { layerBots } from "./layer.ts";
import type { BotActor } from "./rules.ts";

export const LAPTOP: BotActor = { sessionId: "session-laptop", label: "Laptop" };
export const PHONE: BotActor = { sessionId: "session-phone", label: "Phone" };

export const PROJECT = ProjectId.make("project-api");
export const OTHER_PROJECT = ProjectId.make("project-web");
export const DELETED_PROJECT = ProjectId.make("project-deleted");
export const CLAUDE = ProviderInstanceId.make("claude-work");
export const CODEX = ProviderInstanceId.make("codex-work");

export const botInput = (overrides: Partial<HoustonBotSaveInput> = {}): HoustonBotSaveInput => ({
  target: null,
  name: "Digest writer",
  mark: "📰",
  job: "Writes the morning digest",
  instructions: "List the work, one line per item.",
  defaultProjectId: PROJECT,
  otherProjectIds: [],
  modelSelection: { instanceId: CLAUDE, model: "opus" },
  askedMode: "auto",
  unattendedFullAccess: false,
  maxAtOnce: 1,
  maxStartsPerDay: 6,
  maxMinutes: 20,
  ...overrides,
});

/** A save of `bot` as the client last read it. */
export const editOf = (
  bot: HoustonBot,
  overrides: Partial<HoustonBotSaveInput> = {},
): HoustonBotSaveInput =>
  botInput({
    target: { botId: bot.id, expectedRevision: bot.rowRevision },
    name: bot.name,
    mark: bot.mark,
    job: bot.job,
    defaultProjectId: bot.defaultProjectId,
    otherProjectIds: bot.otherProjectIds,
    modelSelection: bot.modelSelection,
    askedMode: bot.askedMode,
    unattendedFullAccess: bot.unattendedFullAccess,
    maxAtOnce: bot.maxAtOnce,
    maxStartsPerDay: bot.maxStartsPerDay,
    maxMinutes: bot.maxMinutes,
    ...overrides,
  });

const project = (projectId: string, deletedAt: string | null) =>
  ({ projectId, deletedAt }) as never;

/** Two live projects and one deleted; every other id is unknown. */
export const layerTestProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
  get: (projectId) =>
    Effect.succeed(
      projectId === PROJECT || projectId === OTHER_PROJECT
        ? Option.some(project(projectId, null))
        : projectId === DELETED_PROJECT
          ? Option.some(project(projectId, "2026-01-01T00:00:00.000Z"))
          : Option.none(),
    ),
  list: () =>
    Effect.succeed([
      project(PROJECT, null),
      project(OTHER_PROJECT, null),
      project(DELETED_PROJECT, "2026-01-01T00:00:00.000Z"),
    ]),
  listShells: () => Effect.succeed([]),
});

export const layerTestAccounts = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
  getInstance: (instanceId) =>
    Effect.succeed(
      instanceId === CLAUDE
        ? ({ instanceId, driverKind: "claudeAgent" } as never)
        : instanceId === CODEX
          ? ({ instanceId, driverKind: "codex" } as never)
          : undefined,
    ),
});

export const layerBotsTest = (options: { readonly on?: boolean; readonly file?: string } = {}) =>
  layerBots.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerTestProjects,
        layerTestAccounts,
        ServerSettings.layerTest({ botsEnabled: options.on ?? true }),
      ),
    ),
    Layer.provideMerge(
      Layer.fresh(
        options.file === undefined
          ? SqlitePersistence.layerMemory
          : SqlitePersistence.layerFromPath(options.file),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

export const setSwitch = (on: boolean) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({ botsEnabled: on });
  });

/** Every stored bot row, revision and change. */
export const storedBots = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    bots: yield* sql`SELECT * FROM houston_bots ORDER BY id`,
    revisions: yield* sql`SELECT * FROM houston_bot_revisions ORDER BY bot_id, n`,
    changes: yield* sql`SELECT * FROM houston_bot_changes ORDER BY id`,
  };
});
