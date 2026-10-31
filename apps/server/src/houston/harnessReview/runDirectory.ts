// The run directory is reached from the project root one component at a time and never through a
// symbolic link: a repository that ships `.houston` or a run directory as a link would otherwise
// send the digest of every project thread outside the project or into a tracked path.
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export class RunDirectoryError extends Data.TaggedError("RunDirectoryError")<{
  readonly message: string;
}> {}

const isLink = (fs: FileSystem.FileSystem, file: string) =>
  fs.readLink(file).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

/** `<root>/<relative>` checked from `.houston` down, made with `create`; refuses a link or an escape. */
export const runDirectory = Effect.fn("HarnessRunDirectory.resolve")(function* (
  root: string,
  relative: string,
  options: { readonly create: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = root;
  for (const name of relative.split("/")) {
    current = path.join(current, name);
    if (yield* isLink(fs, current)) {
      return yield* new RunDirectoryError({
        message: `${current} is a symbolic link; a harness review never writes through one`,
      });
    }
    if (options.create && !(yield* fs.exists(current))) yield* fs.makeDirectory(current);
  }
  const realRoot = yield* fs.realPath(root);
  const realDir = yield* fs.realPath(current);
  const inside = path.relative(realRoot, realDir);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
    return yield* new RunDirectoryError({
      message: `${current} resolves to ${realDir}, outside the project ${realRoot}`,
    });
  }
  return current;
});

/** Writes `*\n` to the ignore file only when nothing, not even a link, is at its path. */
export const writeIgnoreFile = Effect.fn("HarnessRunDirectory.writeIgnoreFile")(function* (
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(file, "*\n", { flag: "wx" }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        if ((yield* fs.exists(file)) || (yield* isLink(fs, file))) return;
        return yield* error;
      }),
    ),
  );
});
