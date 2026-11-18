import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { IssueTrackerKind, IssueTrackerProjectBinding, ProjectId } from "@houston-app/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type IssueTrackerBindingsRepositoryError,
} from "./Errors.ts";

const BindingRow = Schema.Struct({
  projectId: ProjectId,
  tracker: IssueTrackerKind,
  scope: Schema.String,
  propertiesJson: Schema.String,
});

const JsonText = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownOption(JsonText);
const encodeJson = Schema.encodeSync(JsonText);

/** The stored property mapping, ignoring anything that is not a non-empty string entry. */
const decodeProperties = (json: string): Readonly<Record<string, string>> => {
  const parsed = Option.getOrNull(decodeJson(json));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).flatMap(([key, value]) =>
      typeof value === "string" && value.length > 0 ? [[key, value] as const] : [],
    ),
  );
};

/**
 * Which standalone issue tracker scope each project reads beside its git host's own issues. A
 * project is bound to one scope at most, and only while it has a row.
 */
export class IssueTrackerBindingsRepository extends Context.Service<
  IssueTrackerBindingsRepository,
  {
    readonly list: Effect.Effect<
      ReadonlyMap<ProjectId, IssueTrackerProjectBinding>,
      IssueTrackerBindingsRepositoryError
    >;
    /** Null unbinds. */
    readonly set: (input: {
      readonly projectId: ProjectId;
      readonly binding: IssueTrackerProjectBinding | null;
      /** When the binding was saved, as an ISO instant. */
      readonly updatedAt: string;
    }) => Effect.Effect<void, IssueTrackerBindingsRepositoryError>;
    /** Unbinds every project that pointed at the tracker, when its credential is removed. */
    readonly removeTracker: (
      tracker: IssueTrackerKind,
    ) => Effect.Effect<void, IssueTrackerBindingsRepositoryError>;
    /** Unbinds one project, when it is deleted; absent rows succeed. */
    readonly removeProject: (
      projectId: ProjectId,
    ) => Effect.Effect<void, IssueTrackerBindingsRepositoryError>;
  }
>()("@houston-app/cli/persistence/IssueTrackerBindings/IssueTrackerBindingsRepository") {}

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): IssueTrackerBindingsRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BindingRow,
    execute: () =>
      sql`
        SELECT project_id AS "projectId", tracker AS "tracker", scope AS "scope",
          properties_json AS "propertiesJson"
        FROM issue_tracker_bindings
      `,
  });

  return IssueTrackerBindingsRepository.of({
    list: listRows(undefined).pipe(
      Effect.map(
        (rows) =>
          new Map(
            rows.map((row) => {
              const properties = decodeProperties(row.propertiesJson);
              return [
                row.projectId,
                {
                  tracker: row.tracker,
                  scope: row.scope,
                  ...(Object.keys(properties).length === 0 ? {} : { properties }),
                },
              ] as const;
            }),
          ),
      ),
      Effect.mapError(toSqlOrDecodeError("listIssueTrackerBindings", "IssueTrackerBinding")),
    ),
    set: Effect.fn("IssueTrackerBindingsRepository.set")(
      function* (input) {
        yield* input.binding === null
          ? sql`DELETE FROM issue_tracker_bindings WHERE project_id = ${input.projectId}`
          : sql`
              INSERT INTO issue_tracker_bindings (project_id, tracker, scope, properties_json, updated_at)
              VALUES (${input.projectId}, ${input.binding.tracker}, ${input.binding.scope},
                ${encodeJson(input.binding.properties ?? {})}, ${input.updatedAt})
              ON CONFLICT (project_id)
              DO UPDATE SET tracker = excluded.tracker, scope = excluded.scope,
                properties_json = excluded.properties_json, updated_at = excluded.updated_at
            `;
      },
      Effect.mapError(
        (cause) => new PersistenceSqlError({ operation: "setIssueTrackerBinding", cause }),
      ),
    ),
    removeTracker: Effect.fn("IssueTrackerBindingsRepository.removeTracker")(
      function* (tracker) {
        yield* sql`DELETE FROM issue_tracker_bindings WHERE tracker = ${tracker}`;
      },
      Effect.mapError(
        (cause) => new PersistenceSqlError({ operation: "removeIssueTrackerBindings", cause }),
      ),
    ),
    removeProject: Effect.fn("IssueTrackerBindingsRepository.removeProject")(
      function* (projectId) {
        yield* sql`DELETE FROM issue_tracker_bindings WHERE project_id = ${projectId}`;
      },
      Effect.mapError(
        (cause) => new PersistenceSqlError({ operation: "removeIssueTrackerBinding", cause }),
      ),
    ),
  });
});

export const layer = Layer.effect(IssueTrackerBindingsRepository, make);
