import { CircleAlertIcon } from "lucide-react";
import { createElement, lazy, Suspense, type ComponentType, type ReactNode } from "react";

import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { Button } from "./ui/button";
import { PanelEmptyState } from "./ui/empty-state";

export type LazySurface<P> = ComponentType<P>;

export function lazySurface<P>(load: () => Promise<ComponentType<P>>): LazySurface<P> {
  return lazy(() => load().then((component) => ({ default: component })));
}

// The webview caches a failed module fetch, so a second import of the chunk fails without a
// request; Retry reloads the page, which fetches a fresh index and module map.
const reloadPage = () => window.location.reload();

// Its own Suspense and error boundary, so a failed chunk degrades only this surface;
// `renderFrame` wraps both the loading placeholder (null) and the failure notice.
export function LazySurfaceBoundary<P extends object>({
  surface,
  props,
  label,
  renderFrame,
  reload = reloadPage,
}: {
  readonly surface: LazySurface<P>;
  readonly props: P;
  readonly label: string;
  readonly renderFrame: (content: ReactNode) => ReactNode;
  readonly reload?: () => void;
}) {
  const failure = (
    <PanelEmptyState
      tone="error"
      icon={<CircleAlertIcon />}
      title={`Could not load the ${label}.`}
      action={
        <Button size="xs" variant="outline" onClick={() => reload()}>
          Retry
        </Button>
      }
    />
  );
  return (
    <RenderErrorBoundary fallback={renderFrame(failure)}>
      <Suspense fallback={renderFrame(null)}>{createElement(surface, props)}</Suspense>
    </RenderErrorBoundary>
  );
}
