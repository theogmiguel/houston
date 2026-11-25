// The bots, their instruction revisions and the record of changes. Writes are serialised, each
// commits in one transaction that checks Labs ▸ Bots, and the change is published in commit order.
import type { ProjectId } from "@houston-app/contracts";
import {
  HOUSTON_BOT_LIMITS,
  HoustonBot,
  type HoustonBotChangeField,
  type HoustonBotDeleteInput,
  type HoustonBotError,
  type HoustonBotRestoreRevisionInput,
  type HoustonBotRevisionInfo,
  type HoustonBotRevisionsInput,
  type HoustonBotRevisionsResult,
  type HoustonBotSaveInput,
  type HoustonBotSetEnabledInput,
  type HoustonBotStreamEvent,
} from "@houston-app/contracts/houston/bots";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSettings from "../../serverSettings.ts";
import { nowIso } from "../tasks/TaskStore.ts";
import {
  type BotActor,
  checkBot,
  encodeModelSelection,
  freeSlug,
  refuse,
  refuseOff,
  refuseUnknownBot,
  slugOf,
} from "./rules.ts";

const LIMITS = HOUSTON_BOT_LIMITS;
/** Who a change at startup is recorded under. */
const HOUSTON_ACTOR: BotActor = { sessionId: "houston", label: "Houston" };

interface BotRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly mark: string;
  readonly job: string;
  readonly default_project_id: string;
  readonly other_project_ids_json: string;
  readonly model_selection_json: string;
  readonly asked_mode: string;
  readonly unattended_full_access: number;
  readonly max_at_once: number;
  readonly max_starts_per_day: number;
  readonly max_minutes: number;
  readonly enabled: number;
  readonly ready_made: string | null;
  readonly row_revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RevisionRow {
  readonly n: number;
  readonly text: string;
  readonly sha256: string;
  readonly accepted_at: string;
  readonly accepted_by_label: string;
  readonly restored_from: number | null;
}

interface BotWrite<A> {
  readonly result: A;
  readonly event: HoustonBotStreamEvent | null;
}

export class HoustonBotStore extends Context.Service<
  HoustonBotStore,
  {
    /** Whether Labs ▸ Bots is on; a setting that cannot be read counts as off. */
    readonly isOn: Effect.Effect<boolean>;
    readonly requireOn: (operation: string) => Effect.Effect<void, HoustonBotError>;
    readonly events: PubSub.PubSub<HoustonBotStreamEvent>;
    readonly list: Effect.Effect<ReadonlyArray<HoustonBot>>;
    readonly find: (botId: string) => Effect.Effect<HoustonBot | undefined>;
    readonly revisions: (
      input: HoustonBotRevisionsInput,
    ) => Effect.Effect<HoustonBotRevisionsResult, HoustonBotError>;
    /** Creates or updates a bot; a changed instructions text makes a new revision. */
    readonly save: (
      input: HoustonBotSaveInput,
      actor: BotActor,
    ) => Effect.Effect<HoustonBot, HoustonBotError>;
    /** Inserts a new revision with an earlier one's text. */
    readonly restoreRevision: (
      input: HoustonBotRestoreRevisionInput,
      actor: BotActor,
    ) => Effect.Effect<HoustonBot, HoustonBotError>;
    /** Switching off is allowed while Labs ▸ Bots is off. */
    readonly setEnabled: (
      input: HoustonBotSetEnabledInput,
    ) => Effect.Effect<HoustonBot, HoustonBotError>;
    /** Deletes a bot, also while Labs ▸ Bots is off; its short name stays reserved. */
    readonly remove: (input: HoustonBotDeleteInput) => Effect.Effect<void, HoustonBotError>;
    /** Takes the projects that are not live off every bot's other projects. */
    readonly dropProjects: (isLive: (projectId: string) => boolean) => Effect.Effect<void>;
  }
>()("@houston-app/cli/houston/bots/Store/HoustonBotStore") {}

const decodeBot = Schema.decodeUnknownOption(HoustonBot);

const parseJson = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

const revisionInfo = (row: RevisionRow): HoustonBotRevisionInfo => ({
  n: row.n,
  sha256: row.sha256,
  acceptedAt: row.accepted_at,
  acceptedByLabel: row.accepted_by_label,
  restoredFrom: row.restored_from,
});

/** The recorded fields `input` changes; a new bot is compared with one without full access. */
const changedFields = (
  before: HoustonBot | null,
  input: HoustonBotSaveInput,
): ReadonlyArray<HoustonBotChangeField> => {
  const fields: Array<HoustonBotChangeField> = [];
  if ((before?.unattendedFullAccess ?? false) !== input.unattendedFullAccess) {
    fields.push("full_access");
  }
  if (before === null) return fields;
  if (
    before.maxAtOnce !== input.maxAtOnce ||
    before.maxStartsPerDay !== input.maxStartsPerDay ||
    before.maxMinutes !== input.maxMinutes
  ) {
    fields.push("ceilings");
  }
  if (encodeModelSelection(before.modelSelection) !== encodeModelSelection(input.modelSelection)) {
    fields.push("account");
  }
  if (
    before.defaultProjectId !== input.defaultProjectId ||
    JSON.stringify(before.otherProjectIds) !== JSON.stringify(input.otherProjectIds)
  ) {
    fields.push("projects");
  }
  return fields;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettings.ServerSettingsService;
  const digest = yield* Digest.Digest;
  const random = yield* SecureRandom.SecureRandom;
  const events = yield* PubSub.unbounded<HoustonBotStreamEvent>();
  const lock = yield* Semaphore.make(1);
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);

  const isOn = settings.getSettings.pipe(
    Effect.map((current) => current.botsEnabled),
    Effect.orElseSucceed(() => false),
  );

  const requireOn: HoustonBotStore["Service"]["requireOn"] = Effect.fn("HoustonBotStore.requireOn")(
    function* (operation) {
      if (!(yield* isOn)) return yield* refuseOff(operation);
    },
  );

  const recentChanges = Effect.fn("HoustonBotStore.recentChanges")(function* (botId: string) {
    const since = DateTime.formatIso(
      DateTime.subtract(yield* DateTime.now, { days: LIMITS.recentChangeDays }),
    );
    const rows = yield* run(sql<{
      readonly field: string;
      readonly at: string;
      readonly by_label: string;
    }>`
      SELECT field, at, by_label FROM houston_bot_changes
      WHERE bot_id = ${botId} AND at >= ${since}
      ORDER BY id DESC LIMIT ${LIMITS.recentChanges}
    `);
    return rows.map((row) => ({ field: row.field, at: row.at, byLabel: row.by_label }));
  });

  const currentRevision = (botId: string) =>
    run(sql<RevisionRow>`
      SELECT * FROM houston_bot_revisions WHERE bot_id = ${botId} ORDER BY n DESC LIMIT 1
    `).pipe(Effect.map((rows) => rows[0]));

  const toBot = Effect.fn("HoustonBotStore.toBot")(function* (row: BotRow) {
    const revision = yield* currentRevision(row.id);
    const bot = decodeBot({
      id: row.id,
      slug: row.slug,
      name: row.name,
      mark: row.mark,
      job: row.job,
      defaultProjectId: row.default_project_id,
      otherProjectIds: parseJson(row.other_project_ids_json),
      modelSelection: parseJson(row.model_selection_json),
      askedMode: row.asked_mode,
      unattendedFullAccess: row.unattended_full_access === 1,
      maxAtOnce: row.max_at_once,
      maxStartsPerDay: row.max_starts_per_day,
      maxMinutes: row.max_minutes,
      enabled: row.enabled === 1,
      readyMade: row.ready_made,
      instructions: revision === undefined ? undefined : revisionInfo(revision),
      recentChanges: yield* recentChanges(row.id),
      rowRevision: row.row_revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    if (Option.isNone(bot)) {
      yield* Effect.logWarning("Houston bots: left out a stored bot that no longer decodes.", {
        botId: row.id,
      });
    }
    return Option.getOrUndefined(bot);
  });

  const list = Effect.gen(function* () {
    const rows = yield* run(sql<BotRow>`
      SELECT * FROM houston_bots WHERE deleted_at IS NULL ORDER BY created_at, rowid
    `);
    const bots = yield* Effect.forEach(rows, toBot);
    return bots.filter((bot) => bot !== undefined);
  });

  const find = Effect.fn("HoustonBotStore.find")(function* (botId: string) {
    const rows = yield* run(sql<BotRow>`
      SELECT * FROM houston_bots WHERE id = ${botId} AND deleted_at IS NULL
    `);
    return rows[0] === undefined ? undefined : yield* toBot(rows[0]);
  });

  const require = Effect.fn("HoustonBotStore.require")(function* (
    operation: string,
    botId: string,
    expectedRevision?: number,
  ) {
    const bot = yield* find(botId);
    if (bot === undefined) return yield* refuseUnknownBot(operation, botId);
    if (expectedRevision !== undefined && bot.rowRevision !== expectedRevision) {
      return yield* refuse(
        "conflict",
        operation,
        `bot ${bot.slug} is at revision ${bot.rowRevision}; this change was made at revision ${expectedRevision}`,
        { field: "expectedRevision", actual: bot.rowRevision },
      );
    }
    return bot;
  });

  /** Runs `body` in one transaction and publishes its event once it has committed. */
  const write = <A>(
    operation: string,
    options: { readonly whileOff: boolean },
    body: Effect.Effect<BotWrite<A>, HoustonBotError>,
  ): Effect.Effect<A, HoustonBotError> =>
    lock.withPermits(1)(
      sql
        .withTransaction(options.whileOff ? body : Effect.andThen(requireOn(operation), body))
        .pipe(
          Effect.catchTags({ SqlError: Effect.die }),
          Effect.tap(({ event }) => (event === null ? Effect.void : PubSub.publish(events, event))),
          Effect.map(({ result }) => result),
          Effect.uninterruptible,
        ),
    );

  const saved = Effect.fn("HoustonBotStore.saved")(function* (operation: string, botId: string) {
    const bot = yield* require(operation, botId);
    return { result: bot, event: { upserted: bot } } satisfies BotWrite<HoustonBot>;
  });

  const insertRevision = Effect.fn("HoustonBotStore.insertRevision")(function* (input: {
    readonly botId: string;
    readonly n: number;
    readonly text: string;
    readonly at: string;
    readonly actor: BotActor;
    readonly restoredFrom: number | null;
  }) {
    const hash = Hex.encode(
      yield* run(digest.digest(Digest.sha256, new TextEncoder().encode(input.text))),
    );
    yield* run(sql`
      INSERT INTO houston_bot_revisions (
        bot_id, n, text, sha256, accepted_at, accepted_by_session, accepted_by_label, restored_from
      ) VALUES (
        ${input.botId}, ${input.n}, ${input.text}, ${hash}, ${input.at}, ${input.actor.sessionId},
        ${input.actor.label}, ${input.restoredFrom}
      )
    `);
  });

  const recordChanges = (
    botId: string,
    fields: ReadonlyArray<HoustonBotChangeField>,
    at: string,
    actor: BotActor,
  ) =>
    Effect.forEach(
      fields,
      (field) =>
        run(sql`
          INSERT INTO houston_bot_changes (bot_id, field, at, by_session, by_label)
          VALUES (${botId}, ${field}, ${at}, ${actor.sessionId}, ${actor.label})
        `),
      { discard: true },
    );

  const touch = (botId: string, at: string) =>
    run(sql`
      UPDATE houston_bots SET row_revision = row_revision + 1, updated_at = ${at}
      WHERE id = ${botId}
    `);

  const create = Effect.fn("HoustonBotStore.create")(function* (
    operation: string,
    input: HoustonBotSaveInput,
    at: string,
  ) {
    // Deleted bots are read too: their short names stay taken.
    const rows = yield* run(sql<{ readonly slug: string; readonly deleted_at: string | null }>`
      SELECT slug, deleted_at FROM houston_bots
    `);
    const actual = rows.filter((row) => row.deleted_at === null).length + 1;
    if (actual > LIMITS.bots) {
      return yield* refuse(
        "limit",
        operation,
        `this would be bot ${actual}; the limit is ${LIMITS.bots}`,
        {
          field: "bots",
          limit: LIMITS.bots,
          actual,
        },
      );
    }
    const id = yield* run(random.uuidV4());
    const slug = freeSlug(slugOf(input.name), new Set(rows.map((row) => row.slug)));
    yield* run(sql`
      INSERT INTO houston_bots (
        id, slug, name, mark, job, default_project_id, other_project_ids_json,
        model_selection_json, asked_mode, unattended_full_access, max_at_once, max_starts_per_day,
        max_minutes, row_revision, created_at, updated_at
      ) VALUES (
        ${id}, ${slug}, ${input.name.trim()}, ${input.mark.trim()}, ${input.job.trim()},
        ${input.defaultProjectId}, ${JSON.stringify(input.otherProjectIds)},
        ${encodeModelSelection(input.modelSelection)}, ${input.askedMode},
        ${input.unattendedFullAccess ? 1 : 0}, ${input.maxAtOnce}, ${input.maxStartsPerDay},
        ${input.maxMinutes}, 1, ${at}, ${at}
      )
    `);
    return id;
  });

  const save: HoustonBotStore["Service"]["save"] = Effect.fn("HoustonBotStore.save")(
    function* (input, actor) {
      const operation = "houston.bots.save";
      const refusal = checkBot(operation, input);
      const { target } = input;
      return yield* write(
        operation,
        { whileOff: false },
        Effect.gen(function* () {
          if (refusal !== null) return yield* refusal;
          const at = yield* nowIso;
          if (target === null) {
            const botId = yield* create(operation, input, at);
            yield* insertRevision({
              botId,
              n: 1,
              text: input.instructions,
              at,
              actor,
              restoredFrom: null,
            });
            yield* recordChanges(botId, changedFields(null, input), at, actor);
            return yield* saved(operation, botId);
          }
          const { botId } = target;
          const before = yield* require(operation, botId, target.expectedRevision);
          yield* run(sql`
            UPDATE houston_bots SET
              name = ${input.name.trim()}, mark = ${input.mark.trim()}, job = ${input.job.trim()},
              default_project_id = ${input.defaultProjectId},
              other_project_ids_json = ${JSON.stringify(input.otherProjectIds)},
              model_selection_json = ${encodeModelSelection(input.modelSelection)},
              asked_mode = ${input.askedMode},
              unattended_full_access = ${input.unattendedFullAccess ? 1 : 0},
              max_at_once = ${input.maxAtOnce}, max_starts_per_day = ${input.maxStartsPerDay},
              max_minutes = ${input.maxMinutes}
            WHERE id = ${botId}
          `);
          yield* touch(botId, at);
          const current = yield* currentRevision(botId);
          if (current?.text !== input.instructions) {
            yield* insertRevision({
              botId,
              n: before.instructions.n + 1,
              text: input.instructions,
              at,
              actor,
              restoredFrom: null,
            });
          }
          yield* recordChanges(botId, changedFields(before, input), at, actor);
          return yield* saved(operation, botId);
        }),
      );
    },
  );

  const restoreRevision: HoustonBotStore["Service"]["restoreRevision"] = Effect.fn(
    "HoustonBotStore.restoreRevision",
  )(function* ({ botId, n, expectedRevision }, actor) {
    const operation = "houston.bots.restoreRevision";
    return yield* write(
      operation,
      { whileOff: false },
      Effect.gen(function* () {
        const bot = yield* require(operation, botId, expectedRevision);
        const rows = yield* run(sql<RevisionRow>`
          SELECT * FROM houston_bot_revisions WHERE bot_id = ${botId} AND n = ${n}
        `);
        const old = rows[0];
        if (old === undefined) {
          return yield* refuse("not_found", operation, `bot ${bot.slug} has no revision ${n}`, {
            field: "n",
          });
        }
        const current = yield* currentRevision(botId);
        if (current?.text === old.text) {
          return yield* refuse(
            "invalid",
            operation,
            `revision ${n} is the same text as the current revision ${bot.instructions.n}`,
            { field: "n" },
          );
        }
        const at = yield* nowIso;
        yield* insertRevision({
          botId,
          n: bot.instructions.n + 1,
          text: old.text,
          at,
          actor,
          restoredFrom: n,
        });
        yield* touch(botId, at);
        return yield* saved(operation, botId);
      }),
    );
  });

  const setEnabled: HoustonBotStore["Service"]["setEnabled"] = Effect.fn(
    "HoustonBotStore.setEnabled",
  )(function* ({ botId, enabled }) {
    const operation = "houston.bots.setEnabled";
    return yield* write(
      operation,
      { whileOff: !enabled },
      Effect.gen(function* () {
        const bot = yield* require(operation, botId);
        if (bot.enabled === enabled) return { result: bot, event: null };
        yield* run(sql`UPDATE houston_bots SET enabled = ${enabled ? 1 : 0} WHERE id = ${botId}`);
        yield* touch(botId, yield* nowIso);
        return yield* saved(operation, botId);
      }),
    );
  });

  const remove: HoustonBotStore["Service"]["remove"] = Effect.fn("HoustonBotStore.remove")(
    function* ({ botId }) {
      const operation = "houston.bots.delete";
      yield* write(
        operation,
        { whileOff: true },
        Effect.gen(function* () {
          const at = yield* nowIso;
          // The row is marked first: the revisions of a bot that is not deleted refuse deletion.
          const marked = yield* run(sql<{ readonly id: string }>`
            UPDATE houston_bots SET enabled = 0, deleted_at = ${at}, updated_at = ${at}
            WHERE id = ${botId} AND deleted_at IS NULL RETURNING id
          `);
          if (marked.length === 0) return yield* refuseUnknownBot(operation, botId);
          yield* run(sql`DELETE FROM houston_bot_revisions WHERE bot_id = ${botId}`);
          yield* run(sql`DELETE FROM houston_bot_changes WHERE bot_id = ${botId}`);
          return { result: undefined, event: { deleted: { botId } } };
        }),
      );
    },
  );

  const revisions: HoustonBotStore["Service"]["revisions"] = Effect.fn("HoustonBotStore.revisions")(
    function* ({ botId, before }) {
      yield* require("houston.bots.revisions", botId);
      const rows = yield* run(sql<RevisionRow>`
        SELECT * FROM houston_bot_revisions
        WHERE bot_id = ${botId} AND n < ${before ?? Number.MAX_SAFE_INTEGER}
        ORDER BY n DESC LIMIT ${LIMITS.revisionsPage + 1}
      `);
      return {
        revisions: rows
          .slice(0, LIMITS.revisionsPage)
          .map((row) => ({ ...revisionInfo(row), text: row.text })),
        hasMore: rows.length > LIMITS.revisionsPage,
      };
    },
  );

  const dropProjects: HoustonBotStore["Service"]["dropProjects"] = Effect.fn(
    "HoustonBotStore.dropProjects",
  )(function* (isLive) {
    const operation = "houston.bots.dropProjects";
    if (!(yield* isOn)) return;
    for (const { id: botId } of yield* list) {
      yield* write(
        operation,
        { whileOff: false },
        Effect.gen(function* () {
          const bot = yield* require(operation, botId);
          const kept: ReadonlyArray<ProjectId> = bot.otherProjectIds.filter(isLive);
          if (kept.length === bot.otherProjectIds.length) return { result: undefined, event: null };
          const at = yield* nowIso;
          yield* run(sql`
            UPDATE houston_bots SET other_project_ids_json = ${JSON.stringify(kept)}
            WHERE id = ${botId}
          `);
          yield* touch(botId, at);
          yield* recordChanges(botId, ["projects"], at, HOUSTON_ACTOR);
          const { event } = yield* saved(operation, botId);
          return { result: undefined, event };
        }),
        // Deleted or switched off since the list was read: nothing is left to take off.
      ).pipe(Effect.catch(() => Effect.void));
    }
  });

  return HoustonBotStore.of({
    isOn,
    requireOn,
    events,
    list,
    find,
    revisions,
    save,
    restoreRevision,
    setEnabled,
    remove,
    dropProjects,
  });
});

export const layer = Layer.effect(HoustonBotStore, make);
