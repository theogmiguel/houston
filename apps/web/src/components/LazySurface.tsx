import { createElement, lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";

import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { Button } from "./ui/button";

/**
 * A component loaded on its first render. A rejected `React.lazy` stays rejected, so each retry
 * after a failed load takes a fresh one; every mount at the same attempt shares one.
 */
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

/**
 * Renders a lazy surface behind its own Suspense and error boundary, so a chunk that fails to
 * load degrades only this surface. `renderFrame` wraps both the loading placeholder (null) and
 * the failure notice.
 */
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
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
      <p>Could not load the {label}.</p>
      <Button size="xs" variant="outline" onClick={() => setAttempt(attempt + 1)}>
        Retry
      </Button>
    </div>
  );
  return (
    <RenderErrorBoundary resetKeys={[attempt]} fallback={renderFrame(failure)}>
      <Suspense fallback={renderFrame(null)}>{createElement(surface.at(attempt), props)}</Suspense>
    </RenderErrorBoundary>
  );
}
