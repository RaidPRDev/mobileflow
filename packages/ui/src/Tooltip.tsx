import * as React from "react";
import { cn } from "./lib/cn";

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}

export function Tooltip({ content, children, side = "top", className }: TooltipProps) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  const show = () => setOpen(true);
  const hide = () => setOpen(false);

  const child = React.cloneElement(children, {
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
    "aria-describedby": open ? id : undefined,
  });

  return (
    <span className="tooltip-root">
      {child}
      {open && (
        <span role="tooltip" id={id} className={cn("tooltip-bubble", `is-${side}`, className)}>
          {content}
        </span>
      )}
    </span>
  );
}
