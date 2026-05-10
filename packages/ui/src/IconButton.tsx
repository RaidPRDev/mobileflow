import * as React from "react";
import { MoreVertical } from "lucide-react";
import { cn } from "./lib/cn";

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "menu";
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant = "default", children, type, ...props }, ref) => (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(variant === "menu" ? "menu-trigger-icon" : "btn btn-ghost btn-icon-sm", className)}
      {...props}
    >
      {children ?? <MoreVertical size={16} />}
    </button>
  ),
);
IconButton.displayName = "IconButton";
