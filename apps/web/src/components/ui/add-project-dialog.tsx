import { Link } from "@tanstack/react-router";
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";

import { cn } from "~/lib/utils";
import type { AddProjectAction } from "../../addProjectFlow";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "./dialog";

export interface AddProjectDialogAction {
  readonly id: AddProjectAction;
  readonly icon: ReactNode;
  readonly heading: string;
  readonly description: string;
  readonly onSelect: () => void;
}

export interface AddProjectDialogIntegration {
  readonly id: string;
  readonly icon: ReactNode;
  readonly name: string;
  readonly onSelect: () => void;
}

const ADD_PROJECT_CARD_GRID_CLS = "grid grid-cols-1 gap-2.5 sm:grid-cols-3";
const ADD_PROJECT_CARD_CLS =
  "flex min-w-0 cursor-pointer flex-col items-start gap-2.5 rounded-(--r-group) border border-border bg-card p-4 text-left outline-none transition-colors duration-(--motion-feedback) ease-standard hover:border-(--border-hover) hover:bg-(--surface-raised) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
const ADD_PROJECT_CARD_ICON_CLS =
  "inline-grid size-5 place-items-center text-secondary-label [&>svg]:size-5";
const ADD_PROJECT_CARD_HEADING_CLS = "text-sm font-medium text-foreground";
const ADD_PROJECT_CARD_DESCRIPTION_CLS = "text-xs leading-4 text-secondary-label";
const ADD_PROJECT_CLONE_LABEL_CLS = "text-2xs font-medium text-secondary-label";
const ADD_PROJECT_CLONE_ROW_CLS = "flex flex-wrap items-center gap-1.5";
const ADD_PROJECT_CHIP_CLS =
  "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-(--r-ctl) border border-border bg-(--surface-raised) px-2.5 text-xs text-foreground outline-none transition-colors duration-(--motion-feedback) ease-standard hover:border-(--border-hover) hover:bg-(--surface-overlay) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&>svg]:size-3.5 [&>svg]:shrink-0";
const ADD_PROJECT_SETTINGS_LINK_CLS =
  "ms-auto cursor-pointer rounded-(--r-badge) text-xs text-(--accent-ink) outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
const ADD_PROJECT_POPUP_CLS = "sm:max-w-[560px]";

export function AddProjectDialogView({
  actions,
  integrations,
  onClose,
}: {
  readonly actions: ReadonlyArray<AddProjectDialogAction>;
  readonly integrations: ReadonlyArray<AddProjectDialogIntegration>;
  readonly onClose: () => void;
}) {
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Moves focus into the dialog once it mounts.
  useEffect(() => {
    cardRefs.current[0]?.focus();
  }, []);

  const moveFocus = (delta: number) => {
    const active = cardRefs.current.indexOf(document.activeElement as HTMLButtonElement);
    if (active === -1) return;
    const next = (active + delta + actions.length) % actions.length;
    cardRefs.current[next]?.focus();
  };

  const handleCardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        moveFocus(1);
        return;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        moveFocus(-1);
        return;
      default:
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className={ADD_PROJECT_POPUP_CLS}>
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className={ADD_PROJECT_CARD_GRID_CLS} onKeyDown={handleCardKeyDown}>
            {actions.map((action, index) => (
              <button
                key={action.id}
                ref={(element) => {
                  cardRefs.current[index] = element;
                }}
                type="button"
                data-add-project-action={action.id}
                onClick={action.onSelect}
                className={ADD_PROJECT_CARD_CLS}
              >
                <span className={ADD_PROJECT_CARD_ICON_CLS}>{action.icon}</span>
                <span className={ADD_PROJECT_CARD_HEADING_CLS}>{action.heading}</span>
                <span className={ADD_PROJECT_CARD_DESCRIPTION_CLS}>{action.description}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <span className={ADD_PROJECT_CLONE_LABEL_CLS}>Clone from</span>
            <div className={ADD_PROJECT_CLONE_ROW_CLS}>
              {integrations.map((integration) => (
                <button
                  key={integration.id}
                  type="button"
                  data-add-project-integration={integration.id}
                  onClick={integration.onSelect}
                  className={ADD_PROJECT_CHIP_CLS}
                >
                  {integration.icon}
                  <span>{integration.name}</span>
                </button>
              ))}
              <Link
                to="/settings/source-control"
                onClick={onClose}
                className={cn(ADD_PROJECT_SETTINGS_LINK_CLS, integrations.length === 0 && "ms-0")}
              >
                Connect a provider
              </Link>
            </div>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
