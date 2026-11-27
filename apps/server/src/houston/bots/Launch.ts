// Asking a bot: one transaction records the bot run with its pinned revision, its policy and the
// launch, then the thread is launched under ids made from the bot run's; the same request id never
// starts a second one, and a launch the server did not finish is repeated with the same ids.
import {
  CommandId,
  MessageId,
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  RuntimeMode,
  ThreadId,
} from "@houston-app/contracts";
import {
  HOUSTON_BOT_LIMITS,
  type HoustonBotAskInput,
  type HoustonBotAskResult,
} from "@houston-app/contracts/houston/bots";
import { randomUuidV4 } from "@houston-app/provider-core/server/randomUuid";
import { resolveProjectSettings } from "@houston-app/shared/projectSettings";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { applyCredentialRules, credentialRules } from "../redact.ts";
import { insertBotRun } from "./botRuns.ts";
import { policyFor } from "./kinds.ts";
import { OPENING_TEMPLATE, openingMessage, revisionMatches } from "./openingBlock.ts";
import { checkAccount, refuse, refuseUnknownBot } from "./rules.ts";
import { HoustonBotStore } from "./Store.ts";
import { type BotWorkspaceGit, resolveBotWorkspace } from "./workspace.ts";

const OPERATION = "houston.bots.ask";
const TITLE_CHARS = 80;
const MASK = credentialRules("[redacted]");

/** What a launch needs again after a restart; cleared once the launcher has accepted it. */
const PendingLaunch = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  text: Schema.String,
});
type PendingLaunch = typeof PendingLaunch.Type;
const PendingLaunchJson = Schema.fromJsonString(PendingLaunch);
const encodeLaunch = Schema.encodeSync(PendingLaunchJson);
const decodeLaunch = Schema.decodeUnknownOption(PendingLaunchJson);

export interface LaunchRow {
  readonly id: string;
  readonly bot_id: string;
  readonly kind: string;
  readonly thread_id: string;
  readonly launch_json: string | null;
}

export const threadIdOf = (botRunId: string) => ThreadId.make(`bot-${botRunId}`);

const titleOf = (botName: string, ownerText: string) => {
  const firstLine = ownerText.trim().split("\n")[0]?.trim() ?? "";
  const cut =
    firstLine.length > TITLE_CHARS ? `${firstLine.slice(0, TITLE_CHARS - 1)}…` : firstLine;
  return `${botName} · ${cut}`;
};

export const makeLaunch = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* HoustonBotStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const accounts = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const launcher = yield* ThreadLaunch.ThreadLaunchService;
  const management = yield* ThreadManagement.ThreadManagementService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const settings = yield* ServerSettings.ServerSettingsService;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const digest = yield* Digest.Digest;
  const lock = yield* Semaphore.make(1);
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);

  const git: BotWorkspaceGit = {
    isRepository: (cwd) =>
      driver.statusDetails(cwd).pipe(
        Effect.map((details) => details.isRepo),
        Effect.orElseSucceed(() => false),
      ),
    currentBranch: (cwd) =>
      driver.resolveBranchName(cwd, "HEAD").pipe(Effect.orElseSucceed(() => null)),
    primaryRemote: (cwd) =>
      driver.resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null)),
    defaultBranch: (cwd, remoteName) =>
      driver.resolveDefaultBranchName(cwd, remoteName).pipe(Effect.orElseSucceed(() => null)),
    hasRef: (cwd, refName) =>
      driver.resolveCommit({ cwd, revision: refName }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
  };

  /** The mode and base the project's next new thread would use; `ask` carries no branch. */
  const workspaceFor = Effect.fn("HoustonBotLaunch.workspace")(function* (
    projectId: ProjectId,
    project: ProjectStore.ProjectRow,
  ) {
    const projectSettings = resolveProjectSettings(
      yield* run(settings.getSettings),
      projectId,
      project,
      null,
    );
    const shells = yield* run(management.getShellSnapshot({ projectId }));
    return yield* resolveBotWorkspace(git, {
      projectSettings,
      workspaceRoot: project.workspaceRoot,
      newProjectsRoot: folders.namedProjectsRoot,
      projectHasThreads: shells.threads.length > 0 || shells.archivedThreads.length > 0,
    });
  });

  const liveProject = (projectId: ProjectId) =>
    projects
      .get(projectId)
      .pipe(Effect.orDie, Effect.map(Option.filter((project) => project.deletedAt === null)));

  const fail = Effect.fn("HoustonBotLaunch.fail")(function* (id: string, message: string) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* run(sql`
      UPDATE houston_bot_runs
      SET state = 'failed', reason = ${applyCredentialRules(message, MASK)}, ended_at = ${now},
        launch_json = NULL
      WHERE id = ${id}
    `);
  });

  /** Launches a recorded bot run's thread; the launcher's receipt makes a repeat harmless. */
  const launchRow = Effect.fn("HoustonBotLaunch.launchRow")(function* (row: LaunchRow) {
    if (row.launch_json === null) return;
    const pending = decodeLaunch(row.launch_json);
    if (Option.isNone(pending)) {
      yield* fail(row.id, "Houston could not read the launch it recorded");
      return;
    }
    const launch: PendingLaunch = pending.value;
    yield* launcher
      .launch({
        commandId: CommandId.make(`houston-bot-run:${row.id}`),
        threadId: ThreadId.make(row.thread_id),
        projectId: launch.projectId,
        title: launch.title,
        modelSelection: launch.modelSelection,
        runtimeMode: launch.runtimeMode,
        interactionMode: "default",
        workspaceStrategy: launch.workspaceStrategy,
        initialMessage: {
          messageId: MessageId.make(`bot-run:${row.id}`),
          text: launch.text,
          attachments: [],
        },
        createdBy: "user",
        creationSource: "server",
        houstonBot: { botId: row.bot_id, botRunId: row.id, kind: "asked" },
      })
      .pipe(
        Effect.flatMap(() =>
          run(sql`UPDATE houston_bot_runs SET launch_json = NULL WHERE id = ${row.id}`),
        ),
        Effect.catch((error) =>
          Effect.andThen(
            fail(row.id, error.message),
            Effect.fail(
              refuse(
                "invalid",
                OPERATION,
                `the thread did not start: ${applyCredentialRules(error.message, MASK)}`,
              ),
            ),
          ),
        ),
      );
  });

  const byRequest = (requestId: string) =>
    run(sql<LaunchRow>`
      SELECT id, bot_id, kind, thread_id, launch_json FROM houston_bot_runs
      WHERE request_id = ${requestId}
    `).pipe(Effect.map((rows) => rows[0]));

  const answer = (row: LaunchRow): HoustonBotAskResult => ({
    botRunId: row.id,
    threadId: row.thread_id,
  });

  /** Everything is checked before anything is written; the switch again inside the write. */
  const record = Effect.fn("HoustonBotLaunch.record")(function* (input: HoustonBotAskInput) {
    const bot = yield* store.find(input.botId);
    if (bot === undefined) return yield* refuseUnknownBot(OPERATION, input.botId);
    if (!bot.enabled) {
      return yield* refuse("invalid", OPERATION, `${bot.name} is switched off`, {
        field: "botId",
      });
    }
    const projectId = input.projectId ?? bot.defaultProjectId;
    if (projectId !== bot.defaultProjectId && !bot.otherProjectIds.includes(projectId)) {
      return yield* refuse(
        "invalid",
        OPERATION,
        `${projectId} is not one of ${bot.name}'s projects`,
        {
          field: "projectId",
        },
      );
    }
    const project = yield* liveProject(projectId);
    if (Option.isNone(project)) {
      return yield* refuse("not_found", OPERATION, `no project ${projectId}`, {
        field: "projectId",
      });
    }
    const ownerText = input.ownerText.trim();
    if (ownerText.length === 0) {
      return yield* refuse("invalid", OPERATION, "the text to the bot is empty", {
        field: "ownerText",
      });
    }
    if (ownerText.length > HOUSTON_BOT_LIMITS.ownerTextChars) {
      return yield* refuse(
        "limit",
        OPERATION,
        `the text to the bot is ${ownerText.length} characters; the limit is ${HOUSTON_BOT_LIMITS.ownerTextChars}`,
        { field: "ownerText", limit: HOUSTON_BOT_LIMITS.ownerTextChars, actual: ownerText.length },
      );
    }
    const { instanceId } = bot.modelSelection;
    const refusal = checkAccount(
      OPERATION,
      instanceId,
      (yield* accounts.getInstance(instanceId))?.driverKind,
    );
    if (refusal !== null) return yield* refusal;
    const n = bot.instructions.n;
    const [revision] = yield* run(sql<{ readonly text: string; readonly sha256: string }>`
      SELECT text, sha256 FROM houston_bot_revisions WHERE bot_id = ${bot.id} AND n = ${n}
    `);
    const matches =
      revision !== undefined &&
      revision.sha256 === bot.instructions.sha256 &&
      (yield* revisionMatches(revision.text, revision.sha256).pipe(
        Effect.provideService(Digest.Digest, digest),
        Effect.orDie,
      ));
    if (!matches || revision === undefined) {
      return yield* refuse(
        "invalid",
        OPERATION,
        `The stored instructions of ${bot.name} do not match revision ${n}.`,
      );
    }
    const others: Array<string> = [];
    for (const otherId of bot.otherProjectIds) {
      const other = yield* liveProject(otherId);
      if (Option.isSome(other)) others.push(other.value.title);
    }
    const workspaceStrategy = yield* workspaceFor(projectId, project.value);
    if (workspaceStrategy.type === "worktree") {
      // A base that does not resolve is refused by name before anything is recorded.
      yield* launcher.checkWorktreeBase({ projectId, workspaceStrategy }).pipe(
        Effect.catchTags({
          ThreadLaunchBaseRefError: (error) =>
            Effect.fail(refuse("invalid", OPERATION, error.message)),
        }),
      );
    }
    const id = yield* randomUuidV4;
    const threadId = threadIdOf(id);
    const launch: PendingLaunch = {
      projectId,
      title: titleOf(bot.name, ownerText),
      modelSelection: bot.modelSelection,
      runtimeMode: bot.askedMode,
      workspaceStrategy,
      text: openingMessage({
        botRunId: id,
        slug: bot.slug,
        revisionN: n,
        name: bot.name,
        job: bot.job,
        projectTitle: project.value.title,
        otherProjectTitles: others,
        instructions: revision.text,
        ownerText,
      }),
    };
    const row: LaunchRow = {
      id,
      bot_id: bot.id,
      kind: "asked",
      thread_id: threadId,
      launch_json: encodeLaunch(launch),
    };
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* store.requireOn(OPERATION);
          // Another window may have switched the bot off after the read above.
          const [current] = yield* sql<{ readonly enabled: number }>`
            SELECT enabled FROM houston_bots WHERE id = ${bot.id}
          `;
          if (current?.enabled !== 1) {
            return yield* refuse("invalid", OPERATION, `${bot.name} is switched off`, {
              field: "botId",
            });
          }
          yield* insertBotRun({
            id,
            requestId: input.requestId,
            botId: bot.id,
            botName: bot.name,
            kind: "asked",
            origin: "owner",
            projectId,
            threadId,
            revisionN: n,
            revisionSha256: revision.sha256,
            template: OPENING_TEMPLATE,
            policy: policyFor({ kind: "asked", bot }),
            startedAt: DateTime.formatIso(yield* DateTime.now),
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
          yield* sql`UPDATE houston_bot_runs SET launch_json = ${row.launch_json} WHERE id = ${id}`;
        }),
      )
      .pipe(Effect.catchTags({ SqlError: Effect.die }));
    return row;
  });

  const ask = Effect.fn("HoustonBotLaunch.ask")(function* (input: HoustonBotAskInput) {
    yield* store.requireOn(OPERATION);
    // One ask at a time, so a click sent twice finds the first one's row.
    const row = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        return (yield* byRequest(input.requestId)) ?? (yield* record(input));
      }),
    );
    yield* launchRow(row);
    return answer(row);
  });

  return { ask, record, launchRow };
});
