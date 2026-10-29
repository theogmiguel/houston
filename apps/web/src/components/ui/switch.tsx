import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "~/lib/utils";

function Switch({
  className,
  size = "default",
  mixed = false,
  ...props
}: SwitchPrimitive.Root.Props & { size?: "default" | "sm"; mixed?: boolean }) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center rounded-full p-[2px] outline-none transition-[background-color,box-shadow] duration-[120ms] focus-visible:outline-2 focus-visible:outline-ring data-checked:bg-primary data-unchecked:bg-[var(--tog-off)] data-disabled:cursor-not-allowed data-disabled:opacity-64 data-[mixed]:bg-[var(--tog-off)]",
        size === "sm"
          ? "h-[18px] w-[30px] [--thumb-size:0.875rem] [--thumb-travel:0.75rem]"
          : "h-5 w-9 [--thumb-size:1rem] [--thumb-travel:1rem]",
        className,
      )}
      data-size={size}
      data-slot="switch"
      data-mixed={mixed ? "" : undefined}
      // Base UI overwrites aria-checked even with undefined; pass it only for mixed state.
      {...(mixed ? { "aria-checked": "mixed" as const } : {})}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-[var(--thumb-size)] shrink-0 origin-left rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.3)] in-[[role=switch]:active,[data-slot=label]:active,[data-slot=field-label]:active]:not-data-disabled:scale-x-110 in-[[role=switch]:active,[data-slot=label]:active,[data-slot=field-label]:active]:rounded-[var(--thumb-size)/calc(var(--thumb-size)*1.1)] [transition:translate_.15s,border-radius_.15s,scale_.1s_.1s,transform-origin_.15s] data-checked:origin-right data-checked:translate-x-[var(--thumb-travel)]",
          mixed &&
            "translate-x-[calc(var(--thumb-travel)/2)] opacity-70 data-checked:translate-x-[calc(var(--thumb-travel)/2)]",
        )}
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
