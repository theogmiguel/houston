import { CircleAlertIcon } from "lucide-react";
import { createElement, lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";

import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { Button } from "./ui/button";
import { PanelEmptyState } from "./ui/empty-state";

// A rejected `React.lazy` stays rejected, so each retry takes a fresh one; mounts at the same
// attempt share it.
export interface LazySurface<P> {
  readonly at: (attempt: number) => ComponentType<P>;
}

export function lazySurface<P>(load: () => Promise<ComponentType<P>>): LazySurface<P> {
  const attempts: Array<ComponentType<P>> = [];
  return {
    at: (attempt) =>
      (attempts[attempt] ??= lazy(() => load().then((component) => ({ default: component })))),
  };
}

// Its own Suspense and error boundary, so a failed chunk degrades only this surface;
// `renderFrame` wraps both the loading placeholder (null) and the failure notice.
export function LazySurfaceBoundary<P extends object>({
  surface,
  props,
  label,
  renderFrame,
}: {
  readonly surface: LazySurface<P>;
  readonly props: P;
  readonly label: string;
  readonly renderFrame: (content: ReactNode) => ReactNode;
}) {
  const [attempt, setAttempt] = useState(0);
  const failure = (
    <PanelEmptyState
      tone="error"
      icon={<CircleAlertIcon />}
      title={`Could not load the ${label}.`}
      action={
        <Button size="xs" variant="outline" onClick={() => setAttempt(attempt + 1)}>
          Retry
        </Button>
      }
    />
  );
  return (
    <RenderErrorBoundary resetKeys={[attempt]} fallback={renderFrame(failure)}>
      <Suspense fallback={renderFrame(null)}>{createElement(surface.at(attempt), props)}</Suspense>
    </RenderErrorBoundary>
  );
}
