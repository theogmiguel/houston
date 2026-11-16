import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  PHONE_EMPTY_ACTIONS_CLS,
  PHONE_EMPTY_BODY_CLS,
  PHONE_EMPTY_STACK_CLS,
  PHONE_EMPTY_TITLE_CLS,
} from "../components/ui/phone-recipes";

/** The one phone empty state: a centred title, one muted line and an optional 44px action. */
export function PhoneEmptyState({
  title,
  children,
  action,
  className,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  title: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={cn(PHONE_EMPTY_STACK_CLS, className)} {...props}>
      <h2 className={PHONE_EMPTY_TITLE_CLS}>{title}</h2>
      <p className={PHONE_EMPTY_BODY_CLS}>{children}</p>
      {action === undefined ? null : <div className={PHONE_EMPTY_ACTIONS_CLS}>{action}</div>}
    </div>
  );
}
