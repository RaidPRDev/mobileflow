import * as React from "react";
import { cn } from "./lib/cn";
import { Spinner } from "./Spinner";

export interface LoadingProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Spinner diameter in px. Matches the 13px status-line text by default. */
  size?: number;
}

/** Spinner + label for "…loading" status lines. Renders inline so it can be
 *  dropped inside an existing status element without disturbing its styling. */
export const Loading = React.forwardRef<HTMLSpanElement, LoadingProps>(
  ({ className, size = 14, children = "Loading…", ...props }, ref) => (
    <span ref={ref} className={cn("loading-inline", className)} role="status" {...props}>
      <Spinner size={size} />
      <span>{children}</span>
    </span>
  ),
);
Loading.displayName = "Loading";
