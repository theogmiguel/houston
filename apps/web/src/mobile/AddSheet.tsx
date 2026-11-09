import { AtSignIcon, PaperclipIcon, PlusIcon, SlashIcon } from "lucide-react";
import { memo, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../components/ui/sheet";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

/** The phone composer's "+" sheet: it routes each row to the desktop attach, mention and command paths. */
export const AddSheet = memo(function AddSheet(props: {
  canAttach: boolean;
  addComposerAttachments: (files: File[]) => Promise<boolean>;
  focusComposer: () => void;
  onMention: () => void;
  onCommands: () => void;
}) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const afterCloseRef = useRef<(() => void) | null>(null);

  const closeThen = (action: () => void) => {
    afterCloseRef.current = action;
    setOpen(false);
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length === 0) return;
          setOpen(false);
          void props.addComposerAttachments(files).then((inserted) => {
            if (!inserted) props.focusComposer();
          });
        }}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => setOpen(true)}
              aria-label="Add attachment or command"
              data-phone-add-sheet-trigger="true"
            />
          }
        >
          <PlusIcon />
        </TooltipTrigger>
        <TooltipPopup>Add attachment or command</TooltipPopup>
      </Tooltip>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        onOpenChangeComplete={(nextOpen) => {
          if (nextOpen) return;
          const action = afterCloseRef.current;
          afterCloseRef.current = null;
          action?.();
        }}
      >
        <SheetPopup side="bottom" data-phone-add-sheet="true">
          <SheetHeader>
            <SheetTitle>Add to message</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-1 px-4 pb-4">
            {props.canAttach ? (
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-start"
                onClick={() => inputRef.current?.click()}
              >
                <PaperclipIcon aria-hidden="true" />
                Attach image or file
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              className="w-full justify-start"
              onClick={() => closeThen(props.onMention)}
            >
              <AtSignIcon aria-hidden="true" />
              Mention a file
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full justify-start"
              onClick={() => closeThen(props.onCommands)}
            >
              <SlashIcon aria-hidden="true" />
              Commands
            </Button>
          </div>
        </SheetPopup>
      </Sheet>
    </>
  );
});
