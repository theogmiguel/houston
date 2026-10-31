import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";

import { cn } from "~/lib/utils";

type InputProps = Omit<InputPrimitive.Props & React.RefAttributes<HTMLInputElement>, "size"> & {
  size?: "sm" | "compact" | "default" | "lg" | number;
  font?: "default" | "mono";
  unstyled?: boolean;
  nativeInput?: boolean;
};

function Input({
  className,
  size = "default",
  font = "default",
  unstyled = false,
  nativeInput = false,
  ...props
}: InputProps) {
  const inputClassName = cn(
    "h-[26px] w-full min-w-0 rounded-[inherit] px-[9px] leading-[26px] outline-none placeholder:text-placeholder [transition:background-color_5000000s_ease-in-out_0s]",
    size === "compact" && "h-[22px] px-2 text-xs leading-[22px]",
    size === "sm" && "h-[22px] px-2 text-xs leading-[22px]",
    size === "lg" && "h-[30px] px-[11px] leading-[30px]",
    props.type === "search" &&
      "[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none",
    props.type === "number" &&
      "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
    props.type === "file" &&
      "text-muted-foreground file:me-3 file:bg-transparent file:font-medium file:text-foreground file:text-sm",
  );
  let inputElement: React.ReactElement;

  if (nativeInput) {
    const { style, onValueChange: _onValueChange, ...nativeInputProps } = props;
    const nativeStyle = typeof style === "function" ? undefined : style;

    inputElement = (
      <input
        className={inputClassName}
        data-slot="input"
        size={typeof size === "number" ? size : undefined}
        style={nativeStyle}
        {...(nativeInputProps as React.ComponentProps<"input">)}
      />
    );
  } else {
    inputElement = (
      <InputPrimitive
        className={inputClassName}
        data-slot="input"
        size={typeof size === "number" ? size : undefined}
        {...props}
      />
    );
  }

  return (
    <span
      className={
        cn(
          !unstyled &&
            "relative inline-flex w-full rounded-[var(--r-ctl)] border border-border bg-[var(--field)] text-[13px] text-foreground transition-[border-color,box-shadow] has-focus-visible:has-aria-invalid:border-destructive has-aria-invalid:border-destructive has-focus-visible:outline-2 has-focus-visible:outline-ring has-disabled:opacity-64",
          !unstyled && size === "compact" && "rounded-[var(--r-ctl)]",
          font === "mono" && "font-mono tabular-nums",
          className,
        ) || undefined
      }
      data-size={size}
      data-slot="input-control"
    >
      {inputElement}
    </span>
  );
}

export { Input, type InputProps };
