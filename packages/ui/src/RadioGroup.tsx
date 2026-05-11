import * as React from "react";
import { cn } from "./lib/cn";

export interface RadioOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps<T extends string = string> {
  value: T | undefined;
  onChange: (value: T) => void;
  options: RadioOption<T>[];
  name?: string;
  className?: string;
  orientation?: "vertical" | "horizontal";
}

export function RadioGroup<T extends string = string>({
  value,
  onChange,
  options,
  name,
  className,
  orientation = "vertical",
}: RadioGroupProps<T>) {
  const groupName = React.useId();
  return (
    <div
      role="radiogroup"
      className={cn("radio-group", orientation === "horizontal" && "is-horizontal", className)}
    >
      {options.map((opt) => {
        const checked = opt.value === value;
        return (
          <label
            key={opt.value}
            className={cn("radio-option", checked && "is-checked", opt.disabled && "is-disabled")}
          >
            <input
              type="radio"
              name={name ?? groupName}
              value={opt.value}
              checked={checked}
              disabled={opt.disabled}
              onChange={() => onChange(opt.value)}
              className="radio-input"
            />
            <span className="radio-dot" aria-hidden />
            <span className="radio-text">
              <span className="radio-label">{opt.label}</span>
              {opt.description && <span className="radio-description">{opt.description}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}
