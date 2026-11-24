import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@houston-app/contracts";
import type { ProviderInstance } from "@houston-app/provider-core/server/driver";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";

const codex = ProviderInstanceId.make("codex");
const piLocal = ProviderInstanceId.make("pi_local");
const claudeLocal = ProviderInstanceId.make("claude_local");

const snapshot = (
  instanceId: ProviderInstanceId,
  driver: string,
  models: ReadonlyArray<string>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-07T00:00:00.000Z",
  models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  slashCommands: [],
  skills: [],
  ...overrides,
});

function setup(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings?: Parameters<typeof ServerSettings.ServerSettingsService.layerTest>[0];
}) {
  const calls: Array<ModelSelection> = [];
  const instance = (provider: ServerProvider) =>
    ({
      instanceId: provider.instanceId,
      snapshot: { getSnapshot: Effect.succeed(provider) },
      textGeneration: {
        generateCommitMessage: ({ modelSelection }: { modelSelection: ModelSelection }) =>
          Effect.sync(() => {
            calls.push(modelSelection);
            return { subject: "s", body: "" };
          }),
        generateReviewGuide: ({ modelSelection }: { modelSelection: ModelSelection }) =>
          Effect.sync(() => {
            calls.push(modelSelection);
            return { guide: "g" };
          }),
      },
    }) as unknown as ProviderInstance;
  const instances = input.providers.map(instance);
  const layer = TextGeneration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          listInstances: Effect.succeed(instances),
          getInstance: (id) =>
            Effect.succeed(instances.find((candidate) => candidate.instanceId === id)),
        }),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => undefined,
        }),
        ServerSettings.ServerSettingsService.layerTest(input.settings ?? {}),
      ),
    ),
  );
  const commit = (modelSelection: ModelSelection) =>
    Effect.gen(function* () {
      const service = yield* TextGeneration.TextGeneration;
      return yield* service.generateCommitMessage({
        cwd: "/repo",
        branch: null,
        stagedSummary: "",
        stagedPatch: "",
        modelSelection,
      });
    }).pipe(Effect.provide(layer));
  const reviewGuide = (modelSelection: ModelSelection) =>
    Effect.gen(function* () {
      const service = yield* TextGeneration.TextGeneration;
      return yield* service.generateReviewGuide({
        cwd: "/repo",
        modelSelection,
      } as Parameters<typeof service.generateReviewGuide>[0]);
    }).pipe(Effect.provide(layer));
  return { calls, commit, reviewGuide };
}

const markedLocal = {
  providerInstances: {
    [piLocal]: {
      driver: ProviderDriverKind.make("pi"),
      inference: "local" as const,
      enabled: true,
    },
  },
};
const builtIn = DEFAULT_SERVER_SETTINGS.textGenerationModelSelection;

describe("TextGeneration local-first routing", () => {
  it.effect("sends the untouched default to a ready local model", () => {
    const fixture = setup({
      providers: [
        snapshot(codex, "codex", ["gpt-6-luna"]),
        snapshot(piLocal, "pi", ["default", "tensorfold/GLM-5.3-Flash"], { inference: "local" }),
      ],
      settings: markedLocal,
    });
    return Effect.gen(function* () {
      yield* fixture.commit(builtIn);
      expect(fixture.calls).toEqual([{ instanceId: piLocal, model: "tensorfold/GLM-5.3-Flash" }]);
    });
  });

  it.effect("keeps a model the user picked, even the built-in one", () => {
    const fixture = setup({
      providers: [
        snapshot(codex, "codex", ["gpt-6-luna"]),
        snapshot(piLocal, "pi", ["tensorfold/GLM-5.3-Flash"], { inference: "local" }),
      ],
      settings: { ...markedLocal, textGenerationModelSelectionExplicit: true },
    });
    return Effect.gen(function* () {
      yield* fixture.commit(builtIn);
      expect(fixture.calls).toEqual([builtIn]);
    });
  });

  it.effect("refuses to send background writing to the cloud when no local model is ready", () => {
    const unavailableLocal = setup({
      providers: [
        snapshot(codex, "codex", ["gpt-6-luna"]),
        snapshot(piLocal, "pi", ["tensorfold/GLM-5.3-Flash"], {
          inference: "local",
          status: "error",
          installed: false,
        }),
      ],
      settings: markedLocal,
    });
    // "Local models only" also holds before any instance is marked local.
    const nothingLocal = setup({ providers: [snapshot(codex, "codex", ["gpt-6-luna"])] });
    return Effect.gen(function* () {
      for (const fixture of [unavailableLocal, nothingLocal]) {
        const error = yield* Effect.flip(fixture.commit(builtIn));
        expect(error.message).toContain("No local model is ready");
        expect(fixture.calls).toEqual([]);
      }
    });
  });

  it.effect("sends background writing to the cloud only when the user chose it", () => {
    const luna = { instanceId: codex, model: "gpt-6-luna" };
    const chosen = setup({
      providers: [snapshot(codex, "codex", ["gpt-6-luna"])],
      settings: { textGenerationModelSelection: luna, textGenerationModelSelectionExplicit: true },
    });
    const anyProvider = setup({
      providers: [snapshot(codex, "codex", ["gpt-6-luna"])],
      settings: { textGenerationFallback: "any" },
    });
    return Effect.gen(function* () {
      yield* chosen.commit(luna);
      expect(chosen.calls).toEqual([luna]);
      yield* anyProvider.commit(builtIn);
      expect(anyProvider.calls).toHaveLength(1);
    });
  });

  it.effect("routes review guides only to an investigating local instance", () => {
    const fixture = setup({
      providers: [
        snapshot(piLocal, "pi", ["tensorfold/GLM-5.3-Flash"], { inference: "local" }),
        snapshot(claudeLocal, "claudeAgent", ["glm"], { inference: "local" }),
      ],
      settings: {
        providerInstances: {
          ...markedLocal.providerInstances,
          [claudeLocal]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            inference: "local" as const,
            enabled: true,
          },
        },
      },
    });
    return Effect.gen(function* () {
      yield* fixture.reviewGuide({ instanceId: piLocal, model: "tensorfold/GLM-5.3-Flash" });
      expect(fixture.calls).toEqual([{ instanceId: claudeLocal, model: "glm" }]);
    });
  });
});
