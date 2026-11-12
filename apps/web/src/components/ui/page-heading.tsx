import type { ReactNode } from "react";

/**
 * A page's title and one muted line. On wider screens the title is for assistive tech only
 * because the header's breadcrumb shows it; a phone keeps the visible title.
 */
export function PageHeading({
  title,
  description,
}: {
  readonly title: ReactNode;
  readonly description: ReactNode;
}) {
  return (
    <header className="flex flex-col max-phone:gap-0.5">
      <h1 className="sr-only max-phone:not-sr-only max-phone:text-title max-phone:font-semibold max-phone:text-foreground">{title}</h1>
      <p className="text-body text-muted-foreground">{description}</p>
    </header>
  );
}
