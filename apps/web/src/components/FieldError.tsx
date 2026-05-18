import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Inline validation error for form fields. Pair with `aria-invalid="true"` on
 * the input itself (which triggers the red border via `.input[aria-invalid="true"]`
 * in Input.less) and `aria-describedby={fieldId + "-error"}` so screen readers
 * announce the message when the field is focused.
 */
export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p className="field-error" id={id} role="alert">
      <AlertCircle size={14} className="field-error__icon" aria-hidden />
      <span>{children}</span>
    </p>
  );
}
