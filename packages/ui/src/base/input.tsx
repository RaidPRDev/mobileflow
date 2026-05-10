import * as React from "react";
import { cn } from "../lib/cn";

export type BaseInputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const BaseInput = React.forwardRef<HTMLInputElement, BaseInputProps>(
  ({ className, type = "text", ...props }, ref) => (
    <input type={type} ref={ref} className={cn("input", className)} {...props} />
  ),
);
BaseInput.displayName = "BaseInput";
