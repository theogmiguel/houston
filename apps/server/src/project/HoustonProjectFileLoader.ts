import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { HOUSTON_PROJECT_FILE_NAME, type HoustonProjectFile } from "@houston-app/contracts";
import { HoustonProjectFileFromJson } from "@houston-app/shared/houstonProjectFile";

const decodeHoustonProjectFileJson = Schema.decodeEffect(HoustonProjectFileFromJson);

export class HoustonProjectFileLoadError extends Schema.TaggedError<HoustonProjectFileLoadError>()(
  "HoustonProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${HOUSTON_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

export class HoustonProjectFileLoader extends Context.Service<
  HoustonProjectFileLoader,
  {
    /** Never fails; missing/unreadable/invalid files return none, with warnings for invalid files. */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<HoustonProjectFile>>;
  }
>()("@houston-app/cli/project/HoustonProjectFileLoader") {}

const logHoustonProjectFileLoadError = (error: HoustonProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: HoustonProjectFileLoader["Service"]["load"] = Effect.fn(
    "HoustonProjectFileLoader.load",
  )(function* (workspaceRoot) {
    const filePath = path.join(workspaceRoot, HOUSTON_PROJECT_FILE_NAME);
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : logHoustonProjectFileLoadError(
                new HoustonProjectFileLoadError({
                  operation: "read",
                  workspaceRoot,
                  filePath,
                  cause: error,
                }),
              ).pipe(Effect.as(Option.none<string>())),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<HoustonProjectFile>();
    }
    return yield* decodeHoustonProjectFileJson(raw.value).pipe(
      Effect.asSome,
      Effect.catchTags({
        SchemaError: (error) =>
          logHoustonProjectFileLoadError(
            new HoustonProjectFileLoadError({
              operation: "decode",
              workspaceRoot,
              filePath,
              cause: error,
            }),
          ).pipe(Effect.as(Option.none<HoustonProjectFile>())),
      }),
    );
  });

  return HoustonProjectFileLoader.of({ load });
});

export const layer = Layer.effect(HoustonProjectFileLoader, make);
