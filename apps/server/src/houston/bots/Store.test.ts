import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@houston-app/contracts";
import type { HoustonBotError } from "@houston-app/contracts/houston/bots";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import {
  botInput,
  CLAUDE,
  editOf,
  LAPTOP,
  layerBotsTest,
  OTHER_PROJECT,
  PHONE,
  PROJECT,
  setSwitch,
  storedBots,
} from "./bots.testkit.ts";
import { BOTS_OFF_MESSAGE } from "./rules.ts";
import { HoustonBotStore } from "./Store.ts";

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

type Test = Effect.Effect<
  void,
  unknown,
  HoustonBotStore | SqlClient.SqlClient | import("../../serverSettings.ts").ServerSettingsService
>;

const withStore = (body: Test, options: { readonly on?: boolean } = {}) =>
  body.pipe(Effect.provide(layerBotsTest(options)));

const failed = <A, R>(effect: Effect.Effect<A, HoustonBotError, R>) => Effect.flip(effect);

describe("saving a bot", () => {
  it.effect("a new bot is off, keeps its short name and starts at revision 1", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        const bot = yield* store.save(botInput(), LAPTOP);
        assert.deepInclude(bot, {
          slug: "digest-writer",
          enabled: false,
          unattendedFullAccess: false,
          maxAtOnce: 1,
          maxStartsPerDay: 6,
          maxMinutes: 20,
          readyMade: null,
          rowRevision: 1,
          recentChanges: [],
        });
        assert.deepInclude(bot.instructions, {
          n: 1,
          sha256: sha256(botInput().instructions),
          acceptedByLabel: "Laptop",
          restoredFrom: null,
        });
        const renamed = yield* store.save(editOf(bot, { name: "Morning news" }), PHONE);
        assert.equal(renamed.slug, "digest-writer");
        assert.equal(renamed.name, "Morning news");
        assert.equal(renamed.rowRevision, 2);
        const second = yield* store.save(botInput(), LAPTOP);
        assert.equal(second.slug, "digest-writer-2");
        assert.deepEqual(
          (yield* store.list).map((entry) => entry.slug),
          ["digest-writer", "digest-writer-2"],
        );
      }),
    ),
  );

  it.effect("a bounded field is refused before anything is written", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        const refusal = yield* failed(store.save(botInput({ name: "n".repeat(61) }), LAPTOP));
        assert.deepInclude(refusal, { kind: "limit", field: "name", limit: 60, actual: 61 });
        assert.deepEqual(yield* storedBots, { bots: [], revisions: [], changes: [] });
      }),
    ),
  );

  it.effect("the 25th bot is refused, naming 24; a deleted bot leaves room", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        for (let index = 0; index < 24; index += 1) yield* store.save(botInput(), LAPTOP);
        const refusal = yield* failed(store.save(botInput(), LAPTOP));
        assert.deepInclude(refusal, {
          kind: "limit",
          operation: "houston.bots.save",
          limit: 24,
          actual: 25,
        });
        const first = (yield* store.list)[0];
        yield* store.remove({ botId: first?.id ?? "" });
        assert.equal((yield* store.save(botInput(), LAPTOP)).slug, "digest-writer-25");
      }),
    ),
  );

  it.effect("two clients saving one bot: the second is refused with the live row revision", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        const bot = yield* store.save(botInput(), LAPTOP);
        const [first, second] = yield* Effect.all(
          [
            Effect.exit(store.save(editOf(bot, { instructions: "from the laptop" }), LAPTOP)),
            Effect.exit(store.save(editOf(bot, { instructions: "from the phone" }), PHONE)),
          ],
          { concurrency: "unbounded" },
        );
        assert.isTrue(Exit.isSuccess(first));
        assert.isTrue(Exit.isFailure(second));
        const refusal = yield* failed(store.save(editOf(bot, { job: "late" }), PHONE));
        assert.deepInclude(refusal, { kind: "conflict", actual: 2 });
        assert.include(refusal.message, "2");
        const { revisions } = yield* store.revisions({ botId: bot.id });
        assert.deepEqual(
          revisions.map((revision) => [revision.n, revision.text]),
          [
            [2, "from the laptop"],
            [1, botInput().instructions],
          ],
        );
      }),
    ),
  );

  it.effect("an unknown or deleted bot is refused by name", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        const bot = yield* store.save(botInput(), LAPTOP);
        yield* store.remove({ botId: bot.id });
        for (const effect of [
          store.save(editOf(bot), LAPTOP),
          store.restoreRevision({ botId: bot.id, n: 1, expectedRevision: 1 }, LAPTOP),
          store.setEnabled({ botId: bot.id, enabled: true }),
          store.revisions({ botId: bot.id }),
          store.remove({ botId: bot.id }),
          store.remove({ botId: "nothing" }),
        ]) {
          assert.equal((yield* failed(Effect.asVoid(effect))).kind, "not_found");
        }
      }),
    ),
  );
});

describe("revisions", () => {
  it.effect("only a changed text makes a revision, and each names who accepted it", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        const bot = yield* store.save(botInput(), LAPTOP);
        const same = yield* store.save(editOf(bot, { job: "Another job" }), PHONE);
        assert.equal(same.instructions.n, 1);
        const edited = yield* store.save(editOf(same, { instructions: "New text" }), PHONE);
        assert.deepInclude(edited.instructions, {
          n: 2,
          sha256: sha256("New text"),
          acceptedByLabel: "Phone",
        });
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(
          (yield* sql<{ accepted_by_session: string }>`
            SELECT accepted_by_session FROM houston_bot_revisions ORDER BY n
          `).map((row) => row.accepted_by_session),
          ["session-laptop", "session-phone"],
        );
      }),
    ),
  );

  it.effect("restore inserts a new revision with the old text", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        const bot = yield* store.save(botInput({ instructions: "one" }), LAPTOP);
        const two = yield* store.save(editOf(bot, { instructions: "two" }), LAPTOP);
        const restored = yield* store.restoreRevision(
          { botId: bot.id, n: 1, expectedRevision: two.rowRevision },
          PHONE,
        );
        assert.deepInclude(restored.instructions, {
          n: 3,
          sha256: sha256("one"),
          acceptedByLabel: "Phone",
          restoredFrom: 1,
        });
        assert.equal(restored.rowRevision, 3);
        const { revisions } = yield* store.revisions({ botId: bot.id });
        assert.deepEqual(
          revisions.map((revision) => [revision.n, revision.text, revision.restoredFrom]),
          [
            [3, "one", 1],
            [2, "two", null],
            [1, "one", null],
          ],
        );
        const restore = (n: number, expectedRevision: number) =>
          failed(store.restoreRevision({ botId: bot.id, n, expectedRevision }, PHONE));
        assert.equal((yield* restore(3, 3)).kind, "invalid");
        assert.equal((yield* restore(1, 3)).kind, "invalid");
        assert.equal((yield* restore(9, 3)).kind, "not_found");
        assert.deepInclude(yield* restore(2, 2), { kind: "conflict", actual: 3 });
      }),
    ),
  );

  it.effect("revisions are read newest first, 20 at a time", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        let bot = yield* store.save(botInput({ instructions: "text 1" }), LAPTOP);
        for (let n = 2; n <= 23; n += 1) {
          bot = yield* store.save(editOf(bot, { instructions: `text ${n}` }), LAPTOP);
        }
        const first = yield* store.revisions({ botId: bot.id });
        assert.lengthOf(first.revisions, 20);
        assert.isTrue(first.hasMore);
        assert.equal(first.revisions[0]?.n, 23);
        const rest = yield* store.revisions({ botId: bot.id, before: 4 });
        assert.deepEqual(
          rest.revisions.map((revision) => revision.n),
          [3, 2, 1],
        );
        assert.isFalse(rest.hasMore);
      }),
    ),
  );

  it.effect("no public method changes or removes a stored revision while the bot exists", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        const bot = yield* store.save(botInput({ instructions: "one" }), LAPTOP);
        const kept = (yield* storedBots).revisions;
        const row = () => Effect.map(store.find(bot.id), (found) => found ?? bot);
        const calls = {
          save: Effect.flatMap(row(), (live) =>
            store.save(editOf(live, { instructions: "changed" }), PHONE),
          ),
          restoreRevision: Effect.flatMap(row(), (live) =>
            store.restoreRevision(
              { botId: bot.id, n: 1, expectedRevision: live.rowRevision },
              PHONE,
            ),
          ),
          setEnabled: store.setEnabled({ botId: bot.id, enabled: true }),
          dropProjects: store.dropProjects(() => false),
          revisions: store.revisions({ botId: bot.id }),
          list: store.list,
          find: store.find(bot.id),
          isOn: store.isOn,
          requireOn: store.requireOn("houston.bots.save"),
        };
        // `remove` is the one path that deletes revisions; it ends the bot. `events` is the stream.
        assert.sameMembers(Object.keys(store), [...Object.keys(calls), "remove", "events"]);
        for (const [name, call] of Object.entries(calls)) {
          yield* Effect.asVoid(call as Effect.Effect<unknown, HoustonBotError>);
          assert.deepEqual((yield* storedBots).revisions[0], kept[0], name);
        }
      }),
    ),
  );

  it.effect("the database refuses an update or a deletion of a revision of a live bot", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        const sql = yield* SqlClient.SqlClient;
        const bot = yield* store.save(botInput(), LAPTOP);
        const before = (yield* storedBots).revisions;
        for (const statement of [
          sql`UPDATE houston_bot_revisions SET text = 'x'`,
          sql`UPDATE houston_bot_revisions SET accepted_by_label = 'x' WHERE bot_id = ${bot.id}`,
          sql`DELETE FROM houston_bot_revisions`,
        ]) {
          assert.isTrue(Exit.isFailure(yield* Effect.exit(statement)));
        }
        assert.deepEqual((yield* storedBots).revisions, before);
      }),
    ),
  );
});

describe("changes are recorded per field", () => {
  it.effect("full access, ceilings, account and projects each name the client", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        const cases = [
          ["full_access", { unattendedFullAccess: true }],
          ["ceilings", { maxAtOnce: 2 }],
          ["ceilings", { maxStartsPerDay: 7 }],
          ["ceilings", { maxMinutes: 21 }],
          ["account", { modelSelection: { instanceId: CLAUDE, model: "haiku" } }],
          ["projects", { defaultProjectId: OTHER_PROJECT }],
          ["projects", { otherProjectIds: [PROJECT] }],
        ] as const;
        for (const [field, overrides] of cases) {
          const bot = yield* store.save(botInput(), LAPTOP);
          const saved = yield* store.save(editOf(bot, overrides), PHONE);
          assert.deepEqual(
            saved.recentChanges.map((change) => [change.field, change.byLabel]),
            [[field, "Phone"]],
          );
          assert.equal(saved.instructions.n, 1);
        }
        const plain = yield* store.save(botInput(), LAPTOP);
        const renamed = yield* store.save(editOf(plain, { name: "N", mark: "", job: "" }), PHONE);
        assert.deepEqual(renamed.recentChanges, []);
        const several = yield* store.save(
          editOf(renamed, { unattendedFullAccess: true, maxMinutes: 5 }),
          PHONE,
        );
        assert.sameMembers(
          several.recentChanges.map((change) => change.field),
          ["full_access", "ceilings"],
        );
        const sql = yield* SqlClient.SqlClient;
        assert.lengthOf(
          yield* sql`SELECT 1 FROM houston_bot_changes WHERE by_session <> 'session-phone'`,
          0,
        );
      }),
    ),
  );

  it.effect("a bot created with full access records it", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        const bot = yield* store.save(botInput({ unattendedFullAccess: true }), PHONE);
        assert.deepEqual(
          bot.recentChanges.map((change) => [change.field, change.byLabel]),
          [["full_access", "Phone"]],
        );
      }),
    ),
  );

  it.effect("a change older than seven days is kept but no longer recent", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        const bot = yield* store.save(botInput(), LAPTOP);
        yield* store.save(editOf(bot, { maxMinutes: 5 }), PHONE);
        yield* TestClock.adjust(Duration.days(8));
        assert.deepEqual((yield* store.find(bot.id))?.recentChanges, []);
        assert.lengthOf((yield* storedBots).changes, 1);
      }),
    ),
  );
});

describe("on, off and deleted", () => {
  it.effect("deleting removes revisions and changes and keeps the short name reserved", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        const kept = yield* store.save(botInput({ name: "Kept" }), LAPTOP);
        const bot = yield* store.save(botInput(), LAPTOP);
        yield* store.save(editOf(bot, { maxMinutes: 5 }), LAPTOP);
        yield* store.remove({ botId: bot.id });
        assert.deepEqual(
          (yield* store.list).map((entry) => entry.id),
          [kept.id],
        );
        const stored = yield* storedBots;
        assert.deepEqual(stored.changes, []);
        assert.deepEqual(
          stored.revisions.map((row) => row["bot_id"]),
          [kept.id],
        );
        assert.equal((yield* store.save(botInput(), LAPTOP)).slug, "digest-writer-2");
      }),
    ),
  );

  it.effect("every change is published in commit order", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        const events = yield* PubSub.subscribe(store.events);
        const bot = yield* store.save(botInput(), LAPTOP);
        const on = yield* store.setEnabled({ botId: bot.id, enabled: true });
        assert.isTrue(on.enabled);
        assert.equal(on.rowRevision, 2);
        yield* store.remove({ botId: bot.id });
        assert.deepEqual(yield* PubSub.takeAll(events), [
          { upserted: bot },
          { upserted: on },
          { deleted: { botId: bot.id } },
        ]);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("a deleted project leaves a bot's other projects, and the record says who", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        const gone = ProjectId.make("project-gone");
        const bot = yield* store.save(
          botInput({ defaultProjectId: gone, otherProjectIds: [gone, OTHER_PROJECT] }),
          LAPTOP,
        );
        const untouched = yield* store.save(botInput({ name: "Untouched" }), LAPTOP);
        yield* store.dropProjects((projectId) => projectId !== gone);
        const swept = yield* store.find(bot.id);
        assert.deepInclude(swept, {
          defaultProjectId: gone,
          otherProjectIds: [OTHER_PROJECT],
          rowRevision: 2,
        });
        assert.deepEqual(
          swept?.recentChanges.map((change) => [change.field, change.byLabel]),
          [["projects", "Houston"]],
        );
        assert.deepEqual(yield* store.find(untouched.id), untouched);
        yield* setSwitch(false);
        yield* store.dropProjects(() => false);
        yield* setSwitch(true);
        assert.deepEqual((yield* store.find(bot.id))?.otherProjectIds, [OTHER_PROJECT]);
      }),
    ),
  );
});

describe("with Labs ▸ Bots off the store writes nothing but a deletion or a switch-off", () => {
  it.effect("each write names the switch", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        const bot = yield* store.save(botInput(), LAPTOP);
        yield* store.setEnabled({ botId: bot.id, enabled: true });
        yield* setSwitch(false);
        const before = yield* storedBots;
        for (const [operation, effect] of [
          ["houston.bots.save", store.save(botInput(), LAPTOP)],
          ["houston.bots.save", store.save(editOf(bot, { job: "x" }), LAPTOP)],
          [
            "houston.bots.restoreRevision",
            store.restoreRevision({ botId: bot.id, n: 1, expectedRevision: 2 }, LAPTOP),
          ],
          ["houston.bots.setEnabled", store.setEnabled({ botId: bot.id, enabled: true })],
        ] as const) {
          const refusal = yield* failed(Effect.asVoid(effect));
          assert.deepInclude(refusal, { kind: "off", operation, message: BOTS_OFF_MESSAGE });
        }
        assert.deepEqual(yield* storedBots, before);
        assert.isFalse((yield* store.setEnabled({ botId: bot.id, enabled: false })).enabled);
        yield* store.remove({ botId: bot.id });
        assert.deepEqual(yield* store.list, []);
      }),
    ),
  );

  it.effect("a server that never turned it on has no bot and no change", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        assert.isFalse(yield* store.isOn);
        assert.equal((yield* failed(store.save(botInput(), LAPTOP))).kind, "off");
        yield* store.dropProjects(() => false);
        assert.deepEqual(yield* storedBots, { bots: [], revisions: [], changes: [] });
      }),
      { on: false },
    ),
  );
});

describe("stored rows", () => {
  it.effect("a row that no longer decodes is left out and can still be deleted", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        const sql = yield* SqlClient.SqlClient;
        const good = yield* store.save(botInput({ name: "Good" }), LAPTOP);
        const bad = yield* store.save(botInput(), LAPTOP);
        yield* sql`UPDATE houston_bots SET model_selection_json = '{' WHERE id = ${bad.id}`;
        assert.deepEqual(
          (yield* store.list).map((bot) => bot.id),
          [good.id],
        );
        yield* store.remove({ botId: bad.id });
      }),
    ),
  );

  it.effect("bots, revisions and changes survive a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "houston-bots-" });
      const file = path.join(dir, "state.sqlite");
      const saved = yield* Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        const bot = yield* store.save(botInput(), LAPTOP);
        return yield* store.save(editOf(bot, { instructions: "two", maxMinutes: 9 }), PHONE);
      }).pipe(Effect.provide(layerBotsTest({ file })));
      yield* Effect.gen(function* () {
        const store = yield* HoustonBotStore;
        assert.deepEqual(yield* store.list, [saved]);
        assert.lengthOf((yield* store.revisions({ botId: saved.id })).revisions, 2);
      }).pipe(Effect.provide(layerBotsTest({ file })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
