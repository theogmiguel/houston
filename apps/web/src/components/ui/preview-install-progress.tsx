import type { PreviewStreamHostSetup } from "@houston-app/contracts";
import {
  previewStreamHostSetupMessage,
  previewStreamInstallPercent,
} from "@houston-app/client-runtime/preview/server-browser-stream";

import { Spinner } from "./spinner";

export function PreviewInstallProgress({ setup }: { readonly setup: PreviewStreamHostSetup }) {
  const percent = previewStreamInstallPercent(setup);
  return (
    <div
      className="visible absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background p-4 text-center"
      aria-busy="true"
    >
      <Spinner size="md" />
      <p role="status" className="max-w-sm text-sm text-muted-foreground">
        {previewStreamHostSetupMessage(setup)}
      </p>
      {percent === null ? null : (
        <div
          role="progressbar"
          aria-label="Headless browser download"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1.5 w-56 overflow-hidden rounded-full bg-(--field)"
        >
          <div
            className="h-full rounded-full bg-(--accent-ink) transition-[width] duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </div>
  );
}
