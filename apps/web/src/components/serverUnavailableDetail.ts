import {
  type PrimaryEnvironmentRequestError,
  readHttpApiStatus,
} from "../environments/primary/auth";

/** The address the client tried (when known) and the error the request ended with. */
export function serverUnavailableDetail(
  error: PrimaryEnvironmentRequestError,
  host: string | null,
): string {
  // The error's own status falls back to 500 when no response arrived; name only a real response.
  const status = readHttpApiStatus(error.cause);
  const outcome = `${error._tag}${status === null ? "" : ` (HTTP ${status})`} during ${error.operation}`;
  return host === null ? outcome : `Tried ${host} · ${outcome}`;
}
