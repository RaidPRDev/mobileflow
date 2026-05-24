import type { BillingConfig } from "../../../api/client";

// Props every processor's payment-method form must accept. The shell loads
// /billing/config and the setup-intent result, then hands them to the active
// processor's component along with org context and callbacks. Each processor
// owns its own billing-address fields since shapes differ (Stripe = single
// line, ConnectPay = split zip etc.).
//
// `clientSecret` is populated for processors that have an inline confirm
// flow (Stripe SetupIntent). `redirectUrl` is populated for processors that
// vault cards via a hosted page (PayPal, ConnectPay). Exactly one is set.
export interface PaymentMethodFormProps {
  orgId: string;
  config: BillingConfig;
  clientSecret?: string;
  redirectUrl?: string;
  onSaved: () => void;
  onCancel: () => void;
}

export type PaymentMethodFormComponent = (props: PaymentMethodFormProps) => JSX.Element | null;
