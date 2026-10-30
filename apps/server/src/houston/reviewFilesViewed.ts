import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { PersistenceSqlError } from "../persistence/Errors.ts";

export const MAX_REVIEW_FILES_VIEWED_ROWS = 500;

/** One worktree's branch; marks on another branch of the same worktree are not listed. */
export interface ReviewFilesViewedScope {
  readonly worktreeRoot: string;
  readonly refName: string;
}

export interface ReviewFileViewedMark {
  readonly path: string;
  readonly headSha: string | null;
  /** "" when the path was absent at the tick. */
  readonly blob: string;
}

export interface ReviewFilesViewedPage {
  readonly files: ReadonlyArray<ReviewFileViewedMark>;
  readonly truncated: boolean;
}

export interface SetReviewFilesViewedInput extends ReviewFilesViewedScope {
  readonly headSha: string | null;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly viewed: boolean;
    readonly blob: string;
  }>;
  readonly viewedAt: string;
}

export class HoustonReviewFilesViewed extends Context.Service<
  HoustonReviewFilesViewed,
  {
    readonly list: (
      scope: ReviewFilesViewedScope,
    ) => Effect.Effect<ReviewFilesViewedPage, PersistenceSqlError>;
    readonly set: (input: SetReviewFilesViewedInput) => Effect.Effect<void, PersistenceSqlError>;
  }
>()("houston/houston/reviewFilesViewed/HoustonReviewFilesViewed") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return HoustonReviewFilesViewed.of({
    list: Effect.fn("HoustonReviewFilesViewed.list")(function* (scope) {
      const rows = yield* sql<{
        readonly path: string;
        readonly head_sha: string | null;
        readonly blob: string;
      }>`
        SELECT path, head_sha, blob
        FROM houston_review_files_viewed
        WHERE worktree_root = ${scope.worktreeRoot} AND ref_name = ${scope.refName}
        ORDER BY path
        LIMIT ${MAX_REVIEW_FILES_VIEWED_ROWS + 1}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(
          (cause) => new PersistenceSqlError({ operation: "listHoustonReviewFilesViewed", cause }),
        ),
      );
      return {
        files: rows
          .slice(0, MAX_REVIEW_FILES_VIEWED_ROWS)
          .map((row) => ({ path: row.path, headSha: row.head_sha, blob: row.blob })),
        truncated: rows.length > MAX_REVIEW_FILES_VIEWED_ROWS,
      };
    }),

    set: Effect.fn("HoustonReviewFilesViewed.set")(function (input) {
      return sql
        .withTransaction(
          Effect.forEach(
            input.files,
            (file) =>
              file.viewed
                ? sql`
                INSERT INTO houston_review_files_viewed (
                  worktree_root, ref_name, path, head_sha, blob, viewed_at
                )
                VALUES (
                  ${input.worktreeRoot}, ${input.refName}, ${file.path},
                  ${input.headSha}, ${file.blob}, ${input.viewedAt}
                )
                ON CONFLICT (worktree_root, ref_name, path)
                DO UPDATE SET head_sha = excluded.head_sha, blob = excluded.blob,
                  viewed_at = excluded.viewed_at
              `
                : sql`
                DELETE FROM houston_review_files_viewed
                WHERE worktree_root = ${input.worktreeRoot}
                  AND ref_name = ${input.refName}
                  AND path = ${file.path}
              `,
            { discard: true },
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) => new PersistenceSqlError({ operation: "setHoustonReviewFilesViewed", cause }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(HoustonReviewFilesViewed, make);
