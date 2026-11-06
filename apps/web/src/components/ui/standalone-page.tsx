import { CircleAlertIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { HoustonWordmark } from "../HoustonWordmark";

export function StandalonePage({ children }: { readonly children: ReactNode }) {
  return (
    // The page owns scrolling because root cannot scroll; safe centering keeps oversized cards top-aligned.
    <div className="flex h-full items-center-safe justify-center overflow-y-auto scrollbar-gutter-both bg-background px-4 py-10 text-foreground sm:px-6">
      <section className="dialog-glass w-full max-w-xl rounded-2xl border p-6">{children}</section>
    </div>
  );
}

export function StandalonePageHeader({
  context,
  title,
  description,
  status,
  detail,
}: {
  readonly context?: ReactNode;
  readonly title: ReactNode;
  readonly description: ReactNode;
  /** `danger` puts an error icon beside the title. */
  readonly status?: "danger";
  /**
   * A muted line under the description, for the technical specifics. A string splits at " · ";
   * each part stays on one line, so the line breaks only at a separator.
   */
  readonly detail?: ReactNode;
}) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-3 text-muted-foreground">
        <span className="flex items-baseline gap-1.5" role="img" aria-label="Houston">
          <HoustonWordmark className="shrink-0 text-xs text-foreground" aria-hidden />
        </span>
        {context ? <span className="text-sm">{context}</span> : null}
      </div>
      <h1
        className={cn(
          "mt-6 text-xl leading-tight font-semibold",
          status !== undefined && "flex items-center gap-2",
        )}
      >
        {status === "danger" ? (
          <CircleAlertIcon
            aria-hidden
            data-slot="standalone-page-status-icon"
            className="size-5 shrink-0 text-destructive-foreground"
          />
        ) : null}
        {title}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      {detail ? (
        <p data-slot="standalone-page-detail" className="mt-1.5 text-xs text-muted-foreground">
          {typeof detail === "string"
            ? detail.split(" · ").map((part, index) => (
                <Fragment key={part}>
                  {index === 0 ? null : " · "}
                  {/* Below `sm` a part may exceed the card, so it wraps rather than overflows. */}
                  <span className="whitespace-nowrap max-sm:whitespace-normal">{part}</span>
                </Fragment>
              ))
            : detail}
        </p>
      ) : null}
    </>
  );
}
