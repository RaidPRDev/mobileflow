import * as React from "react";
import { cn } from "./lib/cn";

export type BadgeVariant = "default" | "accent" | "success" | "warning" | "danger" | "outline" | "solid";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const variantClass: Record<BadgeVariant, string> = {
  default: "",
  accent: "is-accent",
  success: "is-success",
  warning: "is-warning",
  danger: "is-danger",
  outline: "is-outline",
  solid: "is-solid",
};

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant = "default", ...props }, ref) => (
    <span ref={ref} className={cn("badge", variantClass[variant], className)} {...props} />
  ),
);
Badge.displayName = "Badge";
