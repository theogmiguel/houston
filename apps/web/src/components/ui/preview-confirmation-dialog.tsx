import type { PreviewStreamConfirmation } from "@houston-app/client-runtime/preview/server-browser-stream";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";

export function PreviewConfirmationDialog({
  request,
  trust,
  onTrustChange,
  onDeny,
  onAllow,
}: {
  readonly request: PreviewStreamConfirmation;
  readonly trust: boolean;
  readonly onTrustChange: (trust: boolean) => void;
  readonly onDeny: () => void;
  readonly onAllow: () => void;
}) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="preview-confirmation-title"
        className="w-full max-w-md rounded-lg border border-border bg-popover p-4 text-sm shadow-lg"
      >
        <h2 id="preview-confirmation-title" className="font-medium text-foreground">
          Allow the agent to {request.action}?
        </h2>
        <dl className="mt-3 space-y-2 text-xs">
          <div>
            <dt className="text-muted-foreground">Page</dt>
            <dd className="break-all font-mono text-foreground">
              {request.origin || request.pageUrl}
            </dd>
          </div>
          {request.element ? (
            <div>
              <dt className="text-muted-foreground">Element</dt>
              <dd className="text-foreground">
                <span className="font-mono">{request.element.tagName.toLowerCase()}</span>
                {request.element.text ? `: ${request.element.text}` : ""}
                {request.element.selector ? (
                  <span className="mt-1 block break-all font-mono text-muted-foreground">
                    {request.element.selector}
                  </span>
                ) : null}
              </dd>
            </div>
          ) : null}
          {request.text !== null ? (
            <div>
              <dt className="text-muted-foreground">Typed text</dt>
              <dd className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-(--field) p-2 font-mono text-foreground">
                {request.text}
              </dd>
            </div>
          ) : null}
        </dl>
        <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={trust}
            onCheckedChange={(checked) => onTrustChange(checked === true)}
          />
          Trust this workspace for the rest of the session
        </label>
        <p className="mt-2 text-2xs text-muted-foreground">
          Unanswered requests are denied after two minutes.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" type="button" onClick={onDeny}>
            Deny
          </Button>
          <Button size="sm" type="button" onClick={onAllow}>
            Allow
          </Button>
        </div>
      </div>
    </div>
  );
}
