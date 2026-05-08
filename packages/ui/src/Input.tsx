import * as React from "react";
import { BaseInput, type BaseInputProps } from "./base/input";

export type InputProps = BaseInputProps;

export const Input = React.forwardRef<HTMLInputElement, InputProps>((props, ref) => (
  <BaseInput ref={ref} {...props} />
));
Input.displayName = "Input";
