import * as React from "react";
import { cn } from "./lib/cn";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  name?: string;
  ariaLabel?: string;
  className?: string;
}

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, disabled, id, name, ariaLabel, className }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        id={id}
        name={name}
        aria-checked={checked}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => !disabled && onCheckedChange(!checked)}
        className={cn("switch", checked && "is-on", disabled && "is-disabled", className)}
      >
        <span className="switch-label">{checked ? "ON" : "OFF"}</span>
        <span className="switch-thumb" />
      </button>
    );
  },
);
Switch.displayName = "Switch";
