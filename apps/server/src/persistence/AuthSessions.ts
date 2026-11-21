import * as Context from "effect/Context";
import * as NodeSqliteClient from "@houston-app/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  AuthClientMetadataDeviceType,
  AuthDevicePairingMethod,
  AuthEnvironmentScopes,
  AuthGrantScopes,
  AuthSessionId,
  ServerAuthSessionMethod,
} from "@houston-app/contracts";

import {
  type AuthSessionRepositoryError,
  PersistenceDecodeError,
  type PersistenceErrorCorrelation,
  PersistenceSqlError,
} from "./Errors.ts";

export const AuthSessionClientMetadataRecord = Schema.Struct({
  label: Schema.NullOr(Schema.String),
  ipAddress: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  deviceType: AuthClientMetadataDeviceType,
  os: Schema.NullOr(Schema.String),
  browser: Schema.NullOr(Schema.String),
});
export type AuthSessionClientMetadataRecord = typeof AuthSessionClientMetadataRecord.Type;

export const AuthSessionPendingApproval = Schema.Struct({
  grantedScopes: AuthGrantScopes,
  pairedVia: AuthDevicePairingMethod,
  expiresAt: Schema.DateTimeUtcFromString,
});
export type AuthSessionPendingApproval = typeof AuthSessionPendingApproval.Type;

export const AuthSessionRecord = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  scopes: AuthEnvironmentScopes,
  method: ServerAuthSessionMethod,
  client: AuthSessionClientMetadataRecord,
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  pendingApproval: Schema.NullOr(AuthSessionPendingApproval),
});
export type AuthSessionRecord = typeof AuthSessionRecord.Type;

export const CreateAuthSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  scopes: AuthEnvironmentScopes,
  method: ServerAuthSessionMethod,
  client: AuthSessionClientMetadataRecord,
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  pendingApproval: Schema.optionalKey(AuthSessionPendingApproval),
});
export type CreateAuthSessionInput = typeof CreateAuthSessionInput.Type;

export const CreateReplacingActiveAuthSessionInput = Schema.Struct({
  session: CreateAuthSessionInput,
  revokedAt: Schema.DateTimeUtcFromString,
  replaceSessionId: Schema.optionalKey(AuthSessionId),
});
export type CreateReplacingActiveAuthSessionInput =
  typeof CreateReplacingActiveAuthSessionInput.Type;

export const GetAuthSessionByIdInput = Schema.Struct({
  sessionId: AuthSessionId,
});
export type GetAuthSessionByIdInput = typeof GetAuthSessionByIdInput.Type;

export const ListActiveAuthSessionsInput = Schema.Struct({
  now: Schema.DateTimeUtcFromString,
  connectedSessionIds: Schema.optionalKey(Schema.Array(AuthSessionId)),
});
export type ListActiveAuthSessionsInput = typeof ListActiveAuthSessionsInput.Type;

export const RevokeAuthSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeAuthSessionInput = typeof RevokeAuthSessionInput.Type;

export const RevokeOtherAuthSessionsInput = Schema.Struct({
  currentSessionId: AuthSessionId,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeOtherAuthSessionsInput = typeof RevokeOtherAuthSessionsInput.Type;

export const SetAuthSessionLastConnectedAtInput = Schema.Struct({
  sessionId: AuthSessionId,
  lastConnectedAt: Schema.DateTimeUtcFromString,
});
export type SetAuthSessionLastConnectedAtInput = typeof SetAuthSessionLastConnectedAtInput.Type;

export const ListPendingAuthSessionsInput = Schema.Struct({
  now: Schema.DateTimeUtcFromString,
});
export type ListPendingAuthSessionsInput = typeof ListPendingAuthSessionsInput.Type;

export const ApprovePendingAuthSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
  now: Schema.DateTimeUtcFromString,
});
export type ApprovePendingAuthSessionInput = typeof ApprovePendingAuthSessionInput.Type;

export const ExpirePendingAuthSessionsInput = Schema.Struct({
  now: Schema.DateTimeUtcFromString,
});
export type ExpirePendingAuthSessionsInput = typeof ExpirePendingAuthSessionsInput.Type;

export class AuthSessionRepository extends Context.Service<
  AuthSessionRepository,
  {
    readonly create: (
      input: CreateAuthSessionInput,
    ) => Effect.Effect<void, AuthSessionRepositoryError>;
    readonly createReplacingActive: (
      input: CreateReplacingActiveAuthSessionInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionId>, AuthSessionRepositoryError>;
    readonly createIfAbsent: (
      input: CreateAuthSessionInput,
    ) => Effect.Effect<void, AuthSessionRepositoryError>;
    readonly getById: (
      input: GetAuthSessionByIdInput,
    ) => Effect.Effect<Option.Option<AuthSessionRecord>, AuthSessionRepositoryError>;
    readonly listActive: (
      input: ListActiveAuthSessionsInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionRecord>, AuthSessionRepositoryError>;
    readonly revoke: (
      input: RevokeAuthSessionInput,
    ) => Effect.Effect<boolean, AuthSessionRepositoryError>;
    readonly revokeAllExcept: (
      input: RevokeOtherAuthSessionsInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionId>, AuthSessionRepositoryError>;
    readonly setLastConnectedAt: (
      input: SetAuthSessionLastConnectedAtInput,
    ) => Effect.Effect<void, AuthSessionRepositoryError>;
    readonly listPending: (
      input: ListPendingAuthSessionsInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionRecord>, AuthSessionRepositoryError>;
    readonly approvePending: (
      input: ApprovePendingAuthSessionInput,
    ) => Effect.Effect<Option.Option<AuthSessionRecord>, AuthSessionRepositoryError>;
    readonly expirePending: (
      input: ExpirePendingAuthSessionsInput,
    ) => Effect.Effect<ReadonlyArray<AuthSessionId>, AuthSessionRepositoryError>;
  }
>()("@houston-app/cli/persistence/AuthSessions/AuthSessionRepository") {}

const AuthSessionDbRow = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  scopes: Schema.fromJsonString(AuthEnvironmentScopes),
  method: ServerAuthSessionMethod,
  clientLabel: Schema.NullOr(Schema.String),
  clientIpAddress: Schema.NullOr(Schema.String),
  clientUserAgent: Schema.NullOr(Schema.String),
  clientDeviceType: Schema.Literals(["desktop", "mobile", "tablet", "bot", "unknown"]),
  clientOs: Schema.NullOr(Schema.String),
  clientBrowser: Schema.NullOr(Schema.String),
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  pendingApproval: Schema.NullOr(Schema.fromJsonString(AuthGrantScopes)),
  pendingPairedVia: Schema.NullOr(AuthDevicePairingMethod),
  pendingApprovalExpiresAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

const AuthSessionRawDbRow = Schema.Struct({
  sessionId: Schema.String,
  subject: Schema.Unknown,
  scopes: Schema.Unknown,
  method: Schema.Unknown,
  clientLabel: Schema.Unknown,
  clientIpAddress: Schema.Unknown,
  clientUserAgent: Schema.Unknown,
  clientDeviceType: Schema.Unknown,
  clientOs: Schema.Unknown,
  clientBrowser: Schema.Unknown,
  issuedAt: Schema.Unknown,
  expiresAt: Schema.Unknown,
  lastConnectedAt: Schema.Unknown,
  revokedAt: Schema.Unknown,
  pendingApproval: Schema.Unknown,
  pendingPairedVia: Schema.Unknown,
  pendingApprovalExpiresAt: Schema.Unknown,
});

const decodeAuthSessionDbRow = Schema.decodeUnknownEffect(AuthSessionDbRow);

function toAuthSessionRecord(row: typeof AuthSessionDbRow.Type): AuthSessionRecord {
  return {
    sessionId: row.sessionId,
    subject: row.subject,
    scopes: row.scopes,
    method: row.method,
    client: {
      label: row.clientLabel,
      ipAddress: row.clientIpAddress,
      userAgent: row.clientUserAgent,
      deviceType: row.clientDeviceType,
      os: row.clientOs,
      browser: row.clientBrowser,
    },
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    lastConnectedAt: row.lastConnectedAt,
    revokedAt: row.revokedAt,
    pendingApproval:
      row.pendingApproval === null ||
      row.pendingPairedVia === null ||
      row.pendingApprovalExpiresAt === null
        ? null
        : {
            grantedScopes: row.pendingApproval,
            pairedVia: row.pendingPairedVia,
            expiresAt: row.pendingApprovalExpiresAt,
          },
  };
}

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): AuthSessionRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOperation,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });
}

/** @public */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertSessionRow = (ignoreExisting: boolean) =>
    SqlSchema.void({
      Request: CreateAuthSessionInput,
      execute: (input) =>
        sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          scopes,
          method,
          client_label,
          client_ip_address,
          client_user_agent,
          client_device_type,
          client_os,
          client_browser,
          issued_at,
          expires_at,
          revoked_at,
          pending_approval,
          pending_granted_scopes,
          pending_paired_via,
          pending_approval_expires_at
        )
        VALUES (
          ${input.sessionId},
          ${input.subject},
          ${JSON.stringify(input.scopes)},
          ${input.method},
          ${input.client.label},
          ${input.client.ipAddress},
          ${input.client.userAgent},
          ${input.client.deviceType},
          ${input.client.os},
          ${input.client.browser},
          ${input.issuedAt},
          ${input.expiresAt},
          NULL,
          ${input.pendingApproval === undefined ? 0 : 1},
          ${input.pendingApproval === undefined ? null : JSON.stringify(input.pendingApproval.grantedScopes)},
          ${input.pendingApproval?.pairedVia ?? null},
          ${input.pendingApproval?.expiresAt ?? null}
        )
        ${ignoreExisting ? sql`ON CONFLICT(session_id) DO NOTHING` : sql``}
      `,
    });
  const createSessionRow = insertSessionRow(false);
  const createSessionRowIfAbsent = insertSessionRow(true);

  const getSessionRowById = SqlSchema.findOneOption({
    Request: GetAuthSessionByIdInput,
    Result: AuthSessionRawDbRow,
    execute: ({ sessionId }) =>
      sql`
        SELECT
          session_id AS "sessionId",
          subject AS "subject",
          scopes AS "scopes",
          method AS "method",
          client_label AS "clientLabel",
          client_ip_address AS "clientIpAddress",
          client_user_agent AS "clientUserAgent",
          client_device_type AS "clientDeviceType",
          client_os AS "clientOs",
          client_browser AS "clientBrowser",
          issued_at AS "issuedAt",
          expires_at AS "expiresAt",
          last_connected_at AS "lastConnectedAt",
          revoked_at AS "revokedAt",
          pending_granted_scopes AS "pendingApproval",
          pending_paired_via AS "pendingPairedVia",
          pending_approval_expires_at AS "pendingApprovalExpiresAt"
        FROM auth_sessions
        WHERE session_id = ${sessionId}
      `,
  });

  const revokeActiveSessionsForReplacement = SqlSchema.findAll({
    Request: CreateReplacingActiveAuthSessionInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ session, revokedAt, replaceSessionId }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE ${
          replaceSessionId === undefined
            ? sql`subject = ${session.subject}`
            : sql`session_id = ${replaceSessionId}`
        }
          AND method = ${session.method}
          AND revoked_at IS NULL
          AND expires_at > ${revokedAt}
        RETURNING session_id AS "sessionId"
      `,
  });

  const listActiveSessionRows = SqlSchema.findAll({
    Request: ListActiveAuthSessionsInput,
    Result: AuthSessionRawDbRow,
    execute: ({ now, connectedSessionIds = [] }) =>
      sql`
        SELECT
          session_id AS "sessionId",
          subject AS "subject",
          scopes AS "scopes",
          method AS "method",
          client_label AS "clientLabel",
          client_ip_address AS "clientIpAddress",
          client_user_agent AS "clientUserAgent",
          client_device_type AS "clientDeviceType",
          client_os AS "clientOs",
          client_browser AS "clientBrowser",
          issued_at AS "issuedAt",
          expires_at AS "expiresAt",
          last_connected_at AS "lastConnectedAt",
          revoked_at AS "revokedAt",
          pending_granted_scopes AS "pendingApproval",
          pending_paired_via AS "pendingPairedVia",
          pending_approval_expires_at AS "pendingApprovalExpiresAt"
        FROM auth_sessions
        WHERE revoked_at IS NULL
          AND pending_approval = 0
          AND (expires_at > ${now} OR ${sql.in("session_id", connectedSessionIds)})
        ORDER BY issued_at DESC, session_id DESC
      `,
  });

  const setLastConnectedAtRow = SqlSchema.void({
    Request: SetAuthSessionLastConnectedAtInput,
    execute: ({ sessionId, lastConnectedAt }) =>
      sql`
        UPDATE auth_sessions
        SET last_connected_at = ${lastConnectedAt}
        WHERE session_id = ${sessionId}
          AND revoked_at IS NULL
      `,
  });

  const revokeSessionRows = SqlSchema.findAll({
    Request: RevokeAuthSessionInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ sessionId, revokedAt }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE session_id = ${sessionId}
          AND revoked_at IS NULL
        RETURNING session_id AS "sessionId"
      `,
  });

  const revokeOtherSessionRows = SqlSchema.findAll({
    Request: RevokeOtherAuthSessionsInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ currentSessionId, revokedAt }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${revokedAt}
        WHERE session_id <> ${currentSessionId}
          AND revoked_at IS NULL
        RETURNING session_id AS "sessionId"
      `,
  });

  const listPendingSessionRows = SqlSchema.findAll({
    Request: ListPendingAuthSessionsInput,
    Result: AuthSessionRawDbRow,
    execute: ({ now }) =>
      sql`
        SELECT
          session_id AS "sessionId",
          subject AS "subject",
          scopes AS "scopes",
          method AS "method",
          client_label AS "clientLabel",
          client_ip_address AS "clientIpAddress",
          client_user_agent AS "clientUserAgent",
          client_device_type AS "clientDeviceType",
          client_os AS "clientOs",
          client_browser AS "clientBrowser",
          issued_at AS "issuedAt",
          expires_at AS "expiresAt",
          last_connected_at AS "lastConnectedAt",
          revoked_at AS "revokedAt",
          pending_granted_scopes AS "pendingApproval",
          pending_paired_via AS "pendingPairedVia",
          pending_approval_expires_at AS "pendingApprovalExpiresAt"
        FROM auth_sessions
        WHERE revoked_at IS NULL
          AND pending_approval = 1
          AND pending_approval_expires_at > ${now}
        ORDER BY issued_at DESC, session_id DESC
      `,
  });

  const approvePendingSessionRow = SqlSchema.findOneOption({
    Request: ApprovePendingAuthSessionInput,
    Result: AuthSessionRawDbRow,
    execute: ({ sessionId, now }) =>
      sql`
        UPDATE auth_sessions
        SET scopes = pending_granted_scopes,
            pending_approval = 0,
            pending_granted_scopes = NULL,
            pending_paired_via = NULL,
            pending_approval_expires_at = NULL
        WHERE session_id = ${sessionId}
          AND pending_approval = 1
          AND revoked_at IS NULL
          AND pending_approval_expires_at > ${now}
        RETURNING
          session_id AS "sessionId",
          subject AS "subject",
          scopes AS "scopes",
          method AS "method",
          client_label AS "clientLabel",
          client_ip_address AS "clientIpAddress",
          client_user_agent AS "clientUserAgent",
          client_device_type AS "clientDeviceType",
          client_os AS "clientOs",
          client_browser AS "clientBrowser",
          issued_at AS "issuedAt",
          expires_at AS "expiresAt",
          last_connected_at AS "lastConnectedAt",
          revoked_at AS "revokedAt",
          pending_granted_scopes AS "pendingApproval",
          pending_paired_via AS "pendingPairedVia",
          pending_approval_expires_at AS "pendingApprovalExpiresAt"
      `,
  });

  const expirePendingSessionRows = SqlSchema.findAll({
    Request: ExpirePendingAuthSessionsInput,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ now }) =>
      sql`
        UPDATE auth_sessions
        SET revoked_at = ${now},
            pending_approval = 0,
            pending_granted_scopes = NULL,
            pending_paired_via = NULL,
            pending_approval_expires_at = NULL
        WHERE pending_approval = 1
          AND revoked_at IS NULL
          AND pending_approval_expires_at <= ${now}
        RETURNING session_id AS "sessionId"
      `,
  });

  const create: AuthSessionRepository["Service"]["create"] = (input) =>
    createSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.create:query",
          "AuthSessionRepository.create:encodeRequest",
          { sessionId: input.sessionId },
        ),
      ),
    );

  const createReplacingActive: AuthSessionRepository["Service"]["createReplacingActive"] = (
    input,
  ) =>
    sql
      .withTransaction(
        revokeActiveSessionsForReplacement(input).pipe(
          Effect.flatMap((revokedRows) =>
            createSessionRow(input.session).pipe(
              Effect.as(revokedRows.map((row) => row.sessionId)),
            ),
          ),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "AuthSessionRepository.createReplacingActive:query",
            "AuthSessionRepository.createReplacingActive:encodeRequest",
            { sessionId: input.session.sessionId },
          ),
        ),
      );

  const createIfAbsent: AuthSessionRepository["Service"]["createIfAbsent"] = (input) =>
    createSessionRowIfAbsent(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.createIfAbsent:query",
          "AuthSessionRepository.createIfAbsent:encodeRequest",
          { sessionId: input.sessionId },
        ),
      ),
    );

  const getById: AuthSessionRepository["Service"]["getById"] = (input) =>
    getSessionRowById(input).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.getById:query",
          "AuthSessionRepository.getById:decodeRow",
          { sessionId: input.sessionId },
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeedNone,
          onSome: (row) =>
            decodeAuthSessionDbRow(row).pipe(
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError(
                  "AuthSessionRepository.getById:decodeRow",
                  cause,
                  { sessionId: input.sessionId },
                ),
              ),
              Effect.map((decodedRow) => Option.some(toAuthSessionRecord(decodedRow))),
            ),
        }),
      ),
    );

  const listActive: AuthSessionRepository["Service"]["listActive"] = (input) =>
    listActiveSessionRows(input).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.listActive:query",
          "AuthSessionRepository.listActive:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeAuthSessionDbRow(row).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(
                "AuthSessionRepository.listActive:decodeRows",
                cause,
                { sessionId: row.sessionId },
              ),
            ),
            Effect.map(toAuthSessionRecord),
          ),
        ),
      ),
    );

  const revoke: AuthSessionRepository["Service"]["revoke"] = (input) =>
    revokeSessionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.revoke:query",
          "AuthSessionRepository.revoke:decodeRows",
          { sessionId: input.sessionId },
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const revokeAllExcept: AuthSessionRepository["Service"]["revokeAllExcept"] = (input) =>
    revokeOtherSessionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.revokeAllExcept:query",
          "AuthSessionRepository.revokeAllExcept:decodeRows",
          { currentSessionId: input.currentSessionId },
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.sessionId)),
    );

  const setLastConnectedAt: AuthSessionRepository["Service"]["setLastConnectedAt"] = (input) =>
    setLastConnectedAtRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.setLastConnectedAt:query",
          "AuthSessionRepository.setLastConnectedAt:encodeRequest",
          { sessionId: input.sessionId },
        ),
      ),
    );

  const listPending: AuthSessionRepository["Service"]["listPending"] = (input) =>
    listPendingSessionRows(input).pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.listPending:query",
          "AuthSessionRepository.listPending:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeAuthSessionDbRow(row).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(
                "AuthSessionRepository.listPending:decodeRows",
                cause,
                { sessionId: row.sessionId },
              ),
            ),
            Effect.map(toAuthSessionRecord),
          ),
        ),
      ),
    );

  const approvePending: AuthSessionRepository["Service"]["approvePending"] = (input) =>
    approvePendingSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.approvePending:query",
          "AuthSessionRepository.approvePending:decodeRow",
          { sessionId: input.sessionId },
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeedNone,
          onSome: (row) =>
            decodeAuthSessionDbRow(row).pipe(
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError(
                  "AuthSessionRepository.approvePending:decodeRow",
                  cause,
                  { sessionId: row.sessionId },
                ),
              ),
              Effect.map((decodedRow) => Option.some(toAuthSessionRecord(decodedRow))),
            ),
        }),
      ),
    );

  const expirePending: AuthSessionRepository["Service"]["expirePending"] = (input) =>
    expirePendingSessionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.expirePending:query",
          "AuthSessionRepository.expirePending:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.sessionId)),
    );

  return {
    create,
    createReplacingActive,
    createIfAbsent,
    getById,
    listActive,
    revoke,
    revokeAllExcept,
    setLastConnectedAt,
    listPending,
    approvePending,
    expirePending,
  } satisfies AuthSessionRepository["Service"];
});

export const layer = Layer.effect(AuthSessionRepository, make);
