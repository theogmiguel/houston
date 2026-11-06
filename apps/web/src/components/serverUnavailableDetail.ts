import {
  type PrimaryEnvironmentRequestError,
  readHttpApiStatus,
} from "../environments/primary/auth";

/** The HTTP status the server answered with, or null when no response arrived. */
function answeredStatus(error: PrimaryEnvironmentRequestError): number | null {
  // The error's own status falls back to 500 when no response arrived; name only a real response.
  return readHttpApiStatus(error.cause);
}

/** One sentence on what happened to the request, naming the address the client tried when known. */
export function serverUnavailableDetail(
  error: PrimaryEnvironmentRequestError,
  host: string | null,
): string {
  const status = answeredStatus(error);
  const where = host === null ? "the server" : `the server at ${host}`;
  return status === null
    ? `Couldn't reach ${where}.`
    : `${where[0]!.toUpperCase()}${where.slice(1)} answered HTTP ${status}.`;
}

/** The error tag and failing operation, for the log and the copied report. */
export function serverUnavailableOutcome(error: PrimaryEnvironmentRequestError): string {
  const status = answeredStatus(error);
  return `${error._tag}${status === null ? "" : ` (HTTP ${status})`} during ${error.operation}`;
}
