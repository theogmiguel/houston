import { RouteErrorActions } from "./RouteErrorActions";
import { ErrorLogDisclosure } from "./ui/error-log-disclosure";
import {
  SERVER_UNAVAILABLE_CANVAS,
  SERVER_UNAVAILABLE_CARD,
  SERVER_UNAVAILABLE_CONTENT,
  SERVER_UNAVAILABLE_HEADER,
  SERVER_UNAVAILABLE_HEADER_ACTION,
  SERVER_UNAVAILABLE_HEADER_LABEL,
  SERVER_UNAVAILABLE_SHELL,
  SERVER_UNAVAILABLE_SIDEBAR,
  SERVER_UNAVAILABLE_SIDEBAR_BRAND,
  SERVER_UNAVAILABLE_SIDEBAR_CONTROL,
  SERVER_UNAVAILABLE_SIDEBAR_GROUP,
  SERVER_UNAVAILABLE_SIDEBAR_ROW,
  SERVER_UNAVAILABLE_SIDEBAR_ROW_SHORT,
} from "./ui/server-unavailable-recipes";
import { StandalonePageHeader } from "./ui/standalone-page";

/** The page shown when the primary server cannot be reached; `detail` names what the client tried. */
export function ServerUnavailableCard({
  report,
  detail,
}: {
  readonly report: string;
  readonly detail: string;
}) {
  return (
    <div data-server-unavailable-shell className={SERVER_UNAVAILABLE_SHELL}>
      {/* An empty, dimmed shell keeps the window's shape while the server is down. */}
      <div aria-hidden data-server-unavailable-sidebar className={SERVER_UNAVAILABLE_SIDEBAR}>
        <div className={SERVER_UNAVAILABLE_SIDEBAR_BRAND} />
        <div className={SERVER_UNAVAILABLE_SIDEBAR_CONTROL} />
        <div className={SERVER_UNAVAILABLE_SIDEBAR_GROUP}>
          <div className={SERVER_UNAVAILABLE_SIDEBAR_ROW} />
          <div className={SERVER_UNAVAILABLE_SIDEBAR_CONTROL} />
          <div className={SERVER_UNAVAILABLE_SIDEBAR_ROW_SHORT} />
          <div className={SERVER_UNAVAILABLE_SIDEBAR_CONTROL} />
        </div>
      </div>
      <div className={SERVER_UNAVAILABLE_CONTENT}>
        <div aria-hidden data-server-unavailable-header className={SERVER_UNAVAILABLE_HEADER}>
          <div className={SERVER_UNAVAILABLE_HEADER_LABEL} />
          <div className={SERVER_UNAVAILABLE_HEADER_ACTION} />
        </div>
        <div data-server-unavailable-canvas className={SERVER_UNAVAILABLE_CANVAS}>
          <section data-server-unavailable-card className={SERVER_UNAVAILABLE_CARD}>
            <StandalonePageHeader
              showBrand={false}
              status="danger"
              title="Houston's server isn't running"
              description="Your threads are saved. Start the server to see them."
              detail={detail}
            />
            <RouteErrorActions report={report} />
            <ErrorLogDisclosure report={report} />
          </section>
        </div>
      </div>
    </div>
  );
}
