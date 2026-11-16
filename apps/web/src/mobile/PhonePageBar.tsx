import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../components/ui/button";
import { PHONE_PAGE_BAR_CLS, PHONE_PAGE_BAR_TITLE_CLS } from "../components/ui/phone-recipes";

/** The phone's top bar for a page: an optional back control, the full title, then trailing controls. */
export function PhonePageBar({
  title,
  onBack,
  backLabel = "Back",
  children,
}: {
  title: string;
  onBack?: () => void;
  backLabel?: string;
  children?: ReactNode;
}) {
  return (
    <header data-phone-page-bar="" className={PHONE_PAGE_BAR_CLS}>
      {onBack === undefined ? null : (
        <Button
          variant="ghost"
          size="icon"
          aria-label={backLabel}
          className="-ml-3.5 size-11 shrink-0"
          onClick={onBack}
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
      )}
      <h1 className={PHONE_PAGE_BAR_TITLE_CLS}>{title}</h1>
      {children}
    </header>
  );
}
