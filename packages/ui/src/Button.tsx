import * as React from "react";
import { BaseButton, type BaseButtonProps } from "./base/button";

export type ButtonVariant = "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
export type ButtonSize = "default" | "sm" | "lg" | "icon";

export interface ButtonProps
  extends Omit<BaseButtonProps, "variant" | "size"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ loading, disabled, children, ...props }, ref) => (
    <BaseButton ref={ref} disabled={disabled || loading} {...props}>
      {loading ? <span className="opacity-70">{children}</span> : children}
    </BaseButton>
  ),
);
Button.displayName = "Button";
