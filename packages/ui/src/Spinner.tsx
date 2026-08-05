import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "./lib/cn";

export interface SpinnerProps extends React.SVGAttributes<SVGSVGElement> {
  size?: number;
}

/** Rotating activity indicator. Inherits `currentColor`, so it takes on the
 *  colour of whatever status line it is dropped into. */
export const Spinner = React.forwardRef<SVGSVGElement, SpinnerProps>(
  ({ className, size = 14, ...props }, ref) => (
    <Loader2 ref={ref} size={size} className={cn("spinner", className)} aria-hidden {...props} />
  ),
);
Spinner.displayName = "Spinner";
