import type { ReactNode } from "react";

/** A page's title with one muted line under it. */
export function PageHeading({
  title,
  description,
}: {
  readonly title: ReactNode;
  readonly description: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-0.5">
      <h1 className="text-title font-semibold text-foreground">{title}</h1>
      <p className="text-body text-muted-foreground">{description}</p>
    </header>
  );
}
