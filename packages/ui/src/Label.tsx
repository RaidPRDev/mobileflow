import * as React from "react";
import { BaseLabel } from "./base/label";

export const Label = React.forwardRef<
  React.ElementRef<typeof BaseLabel>,
  React.ComponentPropsWithoutRef<typeof BaseLabel>
>((props, ref) => <BaseLabel ref={ref} {...props} />);
Label.displayName = "Label";
