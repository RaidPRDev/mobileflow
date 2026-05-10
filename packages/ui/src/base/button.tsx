// Class-based Button. Public class names are stable; styles live in the host app's stylesheet.
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../lib/cn";

export type BaseButtonVariant =
  | "default"
  | "destructive"
  | "outline"
  | "secondary"
  | "ghost"
  | "link";

export type BaseButtonSize = "default" | "sm" | "lg" | "icon" | "icon-sm";

export interface BaseButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BaseButtonVariant;
  size?: BaseButtonSize;
  asChild?: boolean;
}

const variantClass: Record<BaseButtonVariant, string> = {
  default: "btn-default",
  destructive: "btn-destructive",
  outline: "btn-outline",
  secondary: "btn-secondary",
  ghost: "btn-ghost",
  link: "btn-link",
};

const sizeClass: Record<BaseButtonSize, string> = {
  default: "",
  sm: "btn-sm",
  lg: "btn-lg",
  icon: "btn-icon",
  "icon-sm": "btn-icon-sm",
};

export const BaseButton = React.forwardRef<HTMLButtonElement, BaseButtonProps>(
  ({ className, variant = "default", size = "default", asChild = false, type, ...props }, ref) => {
    const Comp: React.ElementType = asChild ? Slot : "button";
    return (
      <Comp
        className={cn("btn", variantClass[variant], sizeClass[size], className)}
        ref={ref}
        type={asChild ? undefined : type ?? "button"}
        {...props}
      />
    );
  },
);
BaseButton.displayName = "BaseButton";
