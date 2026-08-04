import * as React from "react";
import { Input, type InputProps } from "@mobileflow/ui";

// Browsers treat every <input type="password"> as an account credential: Chrome
// pops "Save password?" after submit and overlays saved logins on the field.
// That's wrong for secrets that aren't logins — a .p12 passphrase, an API
// secret — so we mask a plain text input with -webkit-text-security instead,
// which keeps the field out of the password manager entirely.
//
// Where the property isn't supported we fall back to a real password input:
// a save prompt is a nuisance, a secret rendered in clear text is not.
const CAN_MASK_TEXT =
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("-webkit-text-security", "disc");

export type SecretInputProps = Omit<InputProps, "type">;

export const SecretInput = React.forwardRef<HTMLInputElement, SecretInputProps>(
  ({ className, ...props }, ref) => (
    <Input
      ref={ref}
      type={CAN_MASK_TEXT ? "text" : "password"}
      className={className ? `is-secret ${className}` : "is-secret"}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      // Opt out of the third-party managers that ignore autocomplete="off".
      data-lpignore="true"
      data-1p-ignore=""
      data-form-type="other"
      {...props}
    />
  ),
);
SecretInput.displayName = "SecretInput";
