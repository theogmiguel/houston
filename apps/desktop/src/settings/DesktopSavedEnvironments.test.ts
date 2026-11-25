import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "./DesktopSavedEnvironments.ts";

describe("DesktopSavedEnvironments", () => {
  it.effect("loads a registry written by a build that still stored relayManaged", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "houston-saved-environments-",
      });
      const registryPath = path.join(directory, "saved-environments.json");
      yield* fileSystem.writeFileString(
        registryPath,
        JSON.stringify({
          version: 1,
          records: [
            {
              environmentId: "environment-legacy",
              label: "Legacy",
              httpBaseUrl: "http://127.0.0.1:3777",
              wsBaseUrl: "ws://127.0.0.1:3777",
              createdAt: "2026-01-01T00:00:00.000Z",
              lastConnectedAt: null,
              relayManaged: { relayUrl: "https://relay.example.test" },
            },
          ],
        }),
      );

      const environment = {
        savedEnvironmentRegistryPath: registryPath,
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"];
      const safeStorage = ElectronSafeStorage.ElectronSafeStorage.of({
        isEncryptionAvailable: Effect.succeed(false),
        encryptString: () => Effect.die("unused"),
        decryptString: () => Effect.die("unused"),
        selectedStorageBackend: Effect.succeedNone,
      });

      const service = yield* DesktopSavedEnvironments.make.pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
        Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, safeStorage),
      );

      const records = yield* service.getRegistry;
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0]?.label, "Legacy");
      assert.isFalse("relayManaged" in (records[0] ?? {}));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
