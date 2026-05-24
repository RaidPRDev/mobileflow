import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../../api/client";
import { PROCESSOR_COMPONENTS } from "./processors";

interface Props {
  orgId: string;
  onSaved: () => void;
  onCancel: () => void;
}

// Thin shell that resolves which processor is active and delegates the
// actual form to the matching component in ./processors. Billing-address
// shape lives inside each processor's form since requirements differ
// (Stripe wants a single address line; future processors may split out zip).
export function PaymentMethodForm({ orgId, onSaved, onCancel }: Props) {
  const cfgQ = useQuery({
    queryKey: ["billing-config"],
    queryFn: () => api.getBillingConfig(),
    staleTime: 60 * 1000,
  });
  const intentQ = useQuery({
    queryKey: ["setup-intent", orgId],
    queryFn: () => api.createSetupIntent(orgId),
    // Don't fire until we know billing is configured — saves an error toast
    // when no processor is set up yet.
    enabled: !!cfgQ.data,
  });

  if (cfgQ.isLoading) return <p className="text-help">Loading…</p>;
  if (!cfgQ.data) return <p className="text-error">Billing is not configured.</p>;

  const Component = PROCESSOR_COMPONENTS[cfgQ.data.provider];
  if (!Component) {
    return (
      <p className="text-error">
        No client implementation for processor &quot;{cfgQ.data.provider}&quot;.
      </p>
    );
  }

  if (intentQ.isLoading) return <p className="text-help">Loading…</p>;
  const hasSetup = !!(intentQ.data?.clientSecret || intentQ.data?.redirectUrl);
  if (intentQ.error || !hasSetup) {
    return (
      <p className="text-error">
        {intentQ.error instanceof ApiError
          ? intentQ.error.message
          : "Could not start payment setup."}
      </p>
    );
  }

  return (
    <Component
      orgId={orgId}
      config={cfgQ.data}
      clientSecret={intentQ.data?.clientSecret}
      redirectUrl={intentQ.data?.redirectUrl}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}
