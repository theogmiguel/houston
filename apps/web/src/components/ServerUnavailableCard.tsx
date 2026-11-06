import { RouteErrorActions } from "./RouteErrorActions";
import { ErrorLogDisclosure } from "./ui/error-log-disclosure";
import { StandalonePage, StandalonePageHeader } from "./ui/standalone-page";

/** The page shown when the primary server cannot be reached; `detail` names what the client tried. */
export function ServerUnavailableCard({
  report,
  detail,
}: {
  readonly report: string;
  readonly detail: string;
}) {
  return (
    <StandalonePage>
      <StandalonePageHeader
        status="danger"
        title="Houston's server isn't running"
        description="Your threads are saved. Start the server to see them."
        detail={detail}
      />
      <RouteErrorActions report={report} />
      <ErrorLogDisclosure report={report} />
    </StandalonePage>
  );
}
