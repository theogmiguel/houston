import type { ReactNode } from "react";

/**
 * A page's one muted line. The title stays in the document outline for assistive tech only:
 * the header's breadcrumb already shows it.
 */
export function PageHeading({
  title,
  description,
}: {
  readonly title: ReactNode;
  readonly description: ReactNode;
}) {
  return (
    <header className="flex flex-col">
      <h1 className="sr-only">{title}</h1>
      <p className="text-body text-muted-foreground">{description}</p>
    </header>
  );
}
