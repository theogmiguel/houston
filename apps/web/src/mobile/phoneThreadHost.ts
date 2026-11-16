import { createContext, use, type RefObject } from "react";

/**
 * What the phone shell lends the chat in its pane: the thread bar owns the details control, so
 * the chat shows its details sheet when the bar asks and reports when it closes. Null outside the
 * phone shell.
 */
export interface PhoneThreadHost {
  readonly detailsOpen: boolean;
  readonly onDetailsOpenChange: (open: boolean) => void;
  readonly detailsAnchor: RefObject<Element | null>;
  /** The bar's details button registers itself as the anchor of the details card. */
  readonly setDetailsAnchor: (node: Element | null) => void;
}

export const PhoneThreadHostContext = createContext<PhoneThreadHost | null>(null);

export const usePhoneThreadHost = () => use(PhoneThreadHostContext);
