// Credential-named query and body parameters masked wherever their text leaves the
// process: the local trace file, the console, exported log records, and HTTP spans.
// Kept in one list so a new OAuth or token name cannot be missed in one redactor
// while the others keep leaking it. Matching is case-insensitive everywhere the
// list is applied.
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

// Header names carry their own secret on HTTP requests: the DPoP proof, the Expo
// `eas login` session token, and the Datadog API key on OTLP exports.
export const SENSITIVE_HEADER_NAMES = ["dpop", "expo-session", "dd-api-key"] as const;

export type SensitiveHeaderName = (typeof SENSITIVE_HEADER_NAMES)[number];
