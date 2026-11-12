import { CheckIcon, PlusIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../components/ui/button";
import { PhoneSheetHeader } from "../components/ui/phone-sheet-header";
import {
  PHONE_SHEET_ROW_CHECK_CLS,
  PHONE_SHEET_ROW_ICON_CLS,
} from "../components/ui/phone-recipes";
import { Sheet, SheetPopup } from "../components/ui/sheet";
import {
  PHONE_TAB_SHEET_PICK_CLS,
  PHONE_TAB_SHEET_ROW_CLS,
  PHONE_TAB_SHEET_TITLE_CLS,
} from "../components/ui/thread-header-recipes";
import { textDirection } from "../textDirection";

export interface PhoneSheetTab {
  readonly id: string;
  readonly title: string;
  readonly mark: ReactNode;
}

/** The pane's tabs as a bottom sheet: pick one, close one, or open a new tab. */
export function PhoneTabsSheet({
  open,
  onOpenChange,
  tabs,
  activeTabId,
  onPick,
  onClose,
  onNewTab,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabs: readonly PhoneSheetTab[];
  activeTabId: string | null;
  onPick: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNewTab: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup
        side="bottom"
        variant="phone"
        showCloseButton={false}
        // The sheet opens on touch: no row takes the keyboard highlight or initial focus.
        initialFocus={false}
        data-phone-tabs-sheet=""
      >
        <PhoneSheetHeader title="Tabs in this pane" />
        <div className="flex flex-col pb-2">
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            return (
              <div key={tab.id} data-phone-tab-row={tab.id} className={PHONE_TAB_SHEET_ROW_CLS}>
                <div className={PHONE_TAB_SHEET_PICK_CLS}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sheet-row"
                    aria-current={active ? "true" : undefined}
                    onClick={() => {
                      onPick(tab.id);
                      onOpenChange(false);
                    }}
                  >
                    <span className={PHONE_SHEET_ROW_ICON_CLS}>{tab.mark}</span>
                    <span dir={textDirection(tab.title)} className={PHONE_TAB_SHEET_TITLE_CLS}>
                      {tab.title}
                    </span>
                    {active ? (
                      <CheckIcon aria-hidden className={PHONE_SHEET_ROW_CHECK_CLS} />
                    ) : null}
                  </Button>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => onClose(tab.id)}
                >
                  <XIcon className="size-4" />
                </Button>
              </div>
            );
          })}
          <Button
            type="button"
            variant="ghost"
            size="sheet-row"
            data-phone-new-tab=""
            onClick={() => {
              onOpenChange(false);
              onNewTab();
            }}
          >
            <PlusIcon aria-hidden className={PHONE_SHEET_ROW_ICON_CLS} />
            New tab
          </Button>
        </div>
      </SheetPopup>
    </Sheet>
  );
}
