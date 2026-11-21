// Credential-named query and body parameters masked wherever their text leaves the process.
// One shared list keeps the trace, HTTP-span and credential-text redactors from drifting apart.
// Matching is case-insensitive wherever the list is applied.
export const SENSITIVE_QUERY_PARAM_NAMES = [
  "wsTicket",
  "dpop",
  "code",
  "state",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "api_key",
  "password",
  "pairingUrl",
  "challenge",
] as const;

export type SensitiveQueryParamName = (typeof SENSITIVE_QUERY_PARAM_NAMES)[number];

// Everyday diagnostics carry `code` and `state` (an error code, a run state); only a URL query or
// form body makes them OAuth values, so those two are masked there and nowhere else.
export const QUERY_ONLY_SENSITIVE_NAMES = ["code", "state"] as const;

export const UNAMBIGUOUS_SENSITIVE_NAMES: ReadonlyArray<SensitiveQueryParamName> =
  SENSITIVE_QUERY_PARAM_NAMES.filter(
    (name) => !(QUERY_ONLY_SENSITIVE_NAMES as ReadonlyArray<string>).includes(name),
  );

// Header names carry their own secret on HTTP requests: the DPoP proof, the Expo
// `eas login` session token, and the Datadog API key on OTLP exports.
export const SENSITIVE_HEADER_NAMES = ["dpop", "expo-session", "dd-api-key"] as const;

export type SensitiveHeaderName = (typeof SENSITIVE_HEADER_NAMES)[number];
