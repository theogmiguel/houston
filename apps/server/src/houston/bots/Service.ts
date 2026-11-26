// The houston.bots.* requests: each is refused by name while Labs ▸ Bots is off, then its projects
// are checked, and its account when a bot is made or moves to another; the store does the rest.
import type { ProjectId } from "@houston-app/contracts";
import type {
  HoustonBot,
  HoustonBotDeleteInput,
  HoustonBotDeleteResult,
  HoustonBotError,
  HoustonBotRestoreRevisionInput,
  HoustonBotRevisionsInput,
  HoustonBotRevisionsResult,
  HoustonBotSaveInput,
  HoustonBotSetEnabledInput,
  HoustonBotStreamEvent,
} from "@houston-app/contracts/houston/bots";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { type BotActor, checkAccount, refuse } from "./rules.ts";
import { HoustonBotStore } from "./Store.ts";

export class HoustonBotService extends Context.Service<
  HoustonBotService,
  {
    /** The bots, then each change; while Labs ▸ Bots is off, only that it is off. */
    readonly subscribe: Stream.Stream<HoustonBotStreamEvent>;
    readonly revisions: (
      input: HoustonBotRevisionsInput,
    ) => Effect.Effect<HoustonBotRevisionsResult, HoustonBotError>;
    readonly save: (
      input: HoustonBotSaveInput,
      actor: BotActor,
    ) => Effect.Effect<HoustonBot, HoustonBotError>;
    readonly restoreRevision: (
      input: HoustonBotRestoreRevisionInput,
      actor: BotActor,
    ) => Effect.Effect<HoustonBot, HoustonBotError>;
    readonly setEnabled: (
      input: HoustonBotSetEnabledInput,
    ) => Effect.Effect<HoustonBot, HoustonBotError>;
    readonly delete: (
      input: HoustonBotDeleteInput,
    ) => Effect.Effect<HoustonBotDeleteResult, HoustonBotError>;
  }
>()("@houston-app/cli/houston/bots/Service/HoustonBotService") {}

type Signal = { readonly on: boolean } | { readonly event: HoustonBotStreamEvent };

const make = Effect.gen(function* () {
  const store = yield* HoustonBotStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const accounts = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;

  const requireProject = (operation: string, field: string, projectId: ProjectId) =>
    projects.get(projectId).pipe(
      Effect.orDie,
      Effect.flatMap((project) =>
        Option.isSome(project) && project.value.deletedAt === null
          ? Effect.void
          : Effect.fail(refuse("not_found", operation, `no project ${projectId}`, { field })),
      ),
    );

  const save: HoustonBotService["Service"]["save"] = Effect.fn("HoustonBotService.save")(
    function* (input, actor) {
      const operation = "houston.bots.save";
      yield* store.requireOn(operation);
      yield* requireProject(operation, "defaultProjectId", input.defaultProjectId);
      for (const projectId of input.otherProjectIds) {
        yield* requireProject(operation, "otherProjectIds", projectId);
      }
      // An account checked before may be only unavailable now; a start checks it again.
      const { instanceId } = input.modelSelection;
      const before = input.target === null ? undefined : yield* store.find(input.target.botId);
      if (before?.modelSelection.instanceId !== instanceId) {
        const account = yield* accounts.getInstance(instanceId);
        const refusal = checkAccount(operation, instanceId, account?.driverKind);
        if (refusal !== null) return yield* refusal;
      }
      return yield* store.save(input, actor);
    },
  );

  const revisions: HoustonBotService["Service"]["revisions"] = Effect.fn(
    "HoustonBotService.revisions",
  )(function* (input) {
    yield* store.requireOn("houston.bots.revisions");
    return yield* store.revisions(input);
  });

  const restoreRevision: HoustonBotService["Service"]["restoreRevision"] = Effect.fn(
    "HoustonBotService.restoreRevision",
  )(function* (input, actor) {
    yield* store.requireOn("houston.bots.restoreRevision");
    return yield* store.restoreRevision(input, actor);
  });

  const setEnabled: HoustonBotService["Service"]["setEnabled"] = Effect.fn(
    "HoustonBotService.setEnabled",
  )(function* (input) {
    yield* store.requireOn("houston.bots.setEnabled");
    return yield* store.setEnabled(input);
  });

  const deleteBot: HoustonBotService["Service"]["delete"] = Effect.fn("HoustonBotService.delete")(
    function* (input) {
      yield* store.requireOn("houston.bots.delete");
      yield* store.remove(input);
      return { deleted: true as const };
    },
  );

  const snapshot = (on: boolean): Effect.Effect<HoustonBotStreamEvent> =>
    on
      ? Effect.map(store.list, (bots) => ({ snapshot: { bots } }))
      : Effect.succeed({ off: true, stopping: 0 });

  const subscribe: HoustonBotService["Service"]["subscribe"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribing before the read keeps every change made during it.
      const switched = yield* settings.subscribeChanges;
      const changes = yield* PubSub.subscribe(store.events);
      const initially = yield* store.isOn;
      const signals = Stream.merge(
        Stream.map(switched, (current): Signal => ({ on: current.botsEnabled })),
        Stream.map(Stream.fromSubscription(changes), (event): Signal => ({ event })),
      );
      return Stream.concat(
        Stream.fromEffect(snapshot(initially)),
        signals.pipe(
          Stream.mapAccumEffect(
            () => initially,
            (on, signal) => {
              if ("event" in signal) return Effect.succeed([on, on ? [signal.event] : []] as const);
              if (signal.on === on) return Effect.succeed([on, []] as const);
              return Effect.map(snapshot(signal.on), (event) => [signal.on, [event]] as const);
            },
          ),
        ),
      );
    }),
  );

  return HoustonBotService.of({
    subscribe,
    revisions,
    save,
    restoreRevision,
    setEnabled,
    delete: deleteBot,
  });
});

export const layer = Layer.effect(HoustonBotService, make);
