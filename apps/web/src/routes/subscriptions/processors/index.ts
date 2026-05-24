import type { PaymentMethodFormComponent } from "./types";
import { StripePaymentMethodForm } from "./stripe/StripePaymentMethodForm";
import { PayPalPaymentMethodForm } from "./paypal/PayPalPaymentMethodForm";
import { ConnectPayPaymentMethodForm } from "./connectpay/ConnectPayPaymentMethodForm";

// Registry of payment-processor React forms. The PaymentMethodForm shell
// reads `provider` from /billing/config and renders the matching component.
// To add a processor: drop a new folder next to ./stripe and register here.
export const PROCESSOR_COMPONENTS: Record<string, PaymentMethodFormComponent> = {
  stripe: StripePaymentMethodForm,
  paypal: PayPalPaymentMethodForm,
  connectpay: ConnectPayPaymentMethodForm,
};
