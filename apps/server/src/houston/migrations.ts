import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

// Upstream's migrator skips every id up to the highest it recorded, so Houston's schema keeps its
// own history table and ids; upstream's table and ids stay untouched.
const HOUSTON_MIGRATIONS_TABLE = "houston_sql_migrations";

const ReviewFilesViewed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Unticks delete their row; ref_name is "" on a detached HEAD, blob "" for an absent path.
  yield* sql`
    CREATE TABLE IF NOT EXISTS houston_review_files_viewed (
      worktree_root TEXT NOT NULL,
      ref_name TEXT NOT NULL,
      path TEXT NOT NULL,
      head_sha TEXT,
      blob TEXT NOT NULL,
      viewed_at TEXT NOT NULL,
      PRIMARY KEY (worktree_root, ref_name, path)
    ) WITHOUT ROWID
  `;
});

const houstonMigrationEntries = [[1, "ReviewFilesViewed", ReviewFilesViewed]] as const;

const run = Migrator.make({});

export const runHoustonMigrations = Effect.fn("runHoustonMigrations")(function* () {
  const executed = yield* run({
    table: HOUSTON_MIGRATIONS_TABLE,
    loader: Migrator.fromRecord(
      Object.fromEntries(
        houstonMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
      ),
    ),
  });
  if (executed.length > 0) {
    yield* Effect.log("Houston migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});
