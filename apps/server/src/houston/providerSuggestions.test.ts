import {
  ProviderDriverKind,
  ProviderInstanceId,
  type LocalAgentSuggestion,
} from "@houston-app/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import { seedLocalAgentSuggestions, type LocalAgentDetector } from "./providerSuggestions.ts";

const pi = ProviderDriverKind.make("pi");
const opencode = ProviderDriverKind.make("opencode");

const detector = (driver: ProviderDriverKind, found: boolean): LocalAgentDetector => ({
  driver,
  found: Effect.succeed(found),
});

function run(
  detectors: ReadonlyArray<LocalAgentDetector>,
  overrides: Parameters<typeof ServerSettings.layerTest>[0],
) {
  return Effect.gen(function* () {
    yield* seedLocalAgentSuggestions(detectors);
    const settings = yield* ServerSettings.ServerSettingsService;
    return (yield* settings.getSettings).localAgentSuggestions;
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest(overrides).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );
}

describe("seedLocalAgentSuggestions", () => {
  effectIt.effect("suggests a found agent that was never configured, and leaves others alone", () =>
    Effect.gen(function* () {
      const suggestions = yield* run([detector(pi, true), detector(opencode, false)], {});
      expect(suggestions[pi]).toMatchObject({ driver: pi, status: "suggested" });
      expect(suggestions[opencode]).toBeUndefined();
    }),
  );

  effectIt.effect("keeps a dismissal and a configuration, and never suggests them again", () =>
    Effect.gen(function* () {
      const dismissed: LocalAgentSuggestion = {
        driver: pi,
        status: "dismissed",
        foundAt: "2026-11-01T00:00:00.000Z",
      };
      const suggestions = yield* run([detector(pi, true), detector(opencode, true)], {
        localAgentSuggestions: { [pi]: dismissed },
        providerInstances: {
          [ProviderInstanceId.make("opencode")]: { driver: opencode, enabled: false },
        },
      });
      expect(suggestions[pi]).toEqual(dismissed);
      expect(suggestions[opencode]).toMatchObject({ status: "enabled" });
    }),
  );

  effectIt.effect("drops a suggestion once the agent is gone", () =>
    Effect.gen(function* () {
      const suggestions = yield* run([detector(pi, false)], {
        localAgentSuggestions: {
          [pi]: { driver: pi, status: "suggested", foundAt: "2026-11-01T00:00:00.000Z" },
        },
      });
      expect(suggestions[pi]).toBeUndefined();
    }),
  );
});
