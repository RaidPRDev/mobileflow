import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "./lib/cn";

export interface ComboboxOption<T extends string = string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  description?: string;
  disabled?: boolean;
}

export interface ComboboxProps<T extends string = string> {
  value: T | undefined;
  onChange: (value: T) => void;
  options: ComboboxOption<T>[];
  placeholder?: string;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  align?: "start" | "center" | "end";
  disabled?: boolean;
  id?: string;
  name?: string;
  ariaLabel?: string;
}

export function Combobox<T extends string = string>({
  value,
  onChange,
  options,
  placeholder = "Select…",
  className,
  triggerClassName,
  contentClassName,
  align = "start",
  disabled,
  id,
  ariaLabel,
}: ComboboxProps<T>) {
  const selected = options.find((o) => o.value === value);
  const triggerButton = (
    <button
      id={id}
      type="button"
      disabled={disabled}
      aria-label={ariaLabel ?? placeholder}
      aria-disabled={disabled || undefined}
      className={cn("combobox-trigger", triggerClassName)}
    >
      <span className="combobox-trigger-content">
        {selected?.icon && <span className="combobox-icon is-tile">{selected.icon}</span>}
        <span>{selected ? selected.label : placeholder}</span>
      </span>
      <ChevronDown size={16} className="combobox-chevron" />
    </button>
  );
  if (disabled) {
    return <div className={cn("combobox", className)}>{triggerButton}</div>;
  }
  return (
    <div className={cn("combobox", className)}>
      {/* modal={false}: when a Combobox is rendered inside a Radix Dialog, both
          primitives default to modal=true, which leaves the dropdown's portaled
          content inert (Dialog blocks pointer events outside its content). The
          symptom is "click the combobox trigger and nothing opens." */}
      <DropdownMenuPrimitive.Root modal={false}>
        <DropdownMenuPrimitive.Trigger asChild>{triggerButton}</DropdownMenuPrimitive.Trigger>
        <DropdownMenuPrimitive.Portal>
          <DropdownMenuPrimitive.Content
            align={align}
            sideOffset={6}
            className={cn("combobox-content", contentClassName)}
          >
            <DropdownMenuPrimitive.RadioGroup
              value={value as string | undefined}
              onValueChange={(v) => onChange(v as T)}
            >
              {options.map((opt) => (
                <DropdownMenuPrimitive.RadioItem
                  key={opt.value}
                  value={opt.value}
                  disabled={opt.disabled}
                  className="combobox-option"
                >
                  {opt.icon && <span className="combobox-icon is-tile">{opt.icon}</span>}
                  <span>{opt.label}</span>
                  <DropdownMenuPrimitive.ItemIndicator className="combobox-option-check">
                    <Check size={14} />
                  </DropdownMenuPrimitive.ItemIndicator>
                </DropdownMenuPrimitive.RadioItem>
              ))}
            </DropdownMenuPrimitive.RadioGroup>
          </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
      </DropdownMenuPrimitive.Root>
    </div>
  );
}
