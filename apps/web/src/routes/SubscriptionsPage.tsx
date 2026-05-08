import { useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@mobileflow/ui";
import { ApiError, api } from "../api/client";

const PAID = ["bohio", "yucayeque", "cacique"] as const;

export function SubscriptionsPage() {
  const { orgId } = useParams();
  const [params] = useSearchParams();
  const checkout = params.get("checkout");

  const subQ = useQuery({ queryKey: ["sub", orgId], queryFn: () => api.getSubscription(orgId!), enabled: !!orgId });
  const plansQ = useQuery({ queryKey: ["billing-plans"], queryFn: () => api.listBillingPlans() });

  const startCheckout = useMutation({
    mutationFn: (planId: (typeof PAID)[number]) => api.startCheckout(orgId!, planId),
    onSuccess: ({ url }) => (window.location.href = url),
  });
  const openPortal = useMutation({
    mutationFn: () => api.openBillingPortal(orgId!),
    onSuccess: ({ url }) => (window.location.href = url),
  });

  const currentPlan = subQ.data?.planId ?? "naboria";

  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-semibold">Subscriptions</h1>

      {checkout === "success" && (
        <p className="text-sm rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-500 p-3">
          Subscription updated. It may take a few seconds to reflect here.
        </p>
      )}
      {checkout === "cancel" && (
        <p className="text-sm rounded-md border bg-muted p-3 text-muted-foreground">
          Checkout was cancelled.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Current plan</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-3 flex-wrap">
          <span className="text-lg font-semibold">{currentPlan}</span>
          <span className="text-xs text-muted-foreground">{subQ.data?.status ?? "—"}</span>
          {subQ.data?.currentPeriodEnd && (
            <span className="text-xs text-muted-foreground">
              {subQ.data.cancelAtPeriodEnd ? "Cancels on" : "Renews on"}{" "}
              {new Date(subQ.data.currentPeriodEnd).toLocaleDateString()}
            </span>
          )}
          {subQ.data?.stripeCustomerId && (
            <Button size="sm" variant="outline" onClick={() => openPortal.mutate()} loading={openPortal.isPending}>
              Manage billing
            </Button>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        {plansQ.data?.map((p) => {
          const isCurrent = currentPlan === p.id;
          const isPaid = (PAID as readonly string[]).includes(p.id);
          return (
            <Card key={p.id} className={isCurrent ? "ring-2 ring-primary" : ""}>
              <CardHeader>
                <CardTitle className="text-base">{p.name}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-2 text-sm">
                <div className="text-2xl font-semibold">
                  {p.priceCents === 0 ? "Free" : `$${(p.priceCents / 100).toFixed(2)}`}
                  {p.priceCents !== 0 && <span className="text-xs text-muted-foreground">/mo</span>}
                </div>
                <ul className="text-xs text-muted-foreground grid gap-1">
                  <li>{p.maxApps ?? "Unlimited"} apps</li>
                  <li>{p.maxSeats ?? "Unlimited"} seats</li>
                  <li>{p.maxConcurrentBuilds ?? "Unlimited"} concurrent builds</li>
                  <li>{p.canBuild ? "Builds enabled" : "Builds disabled (read-only)"}</li>
                </ul>
                <div className="pt-2">
                  {isCurrent ? (
                    <Button size="sm" variant="outline" disabled>
                      Current plan
                    </Button>
                  ) : isPaid ? (
                    <Button
                      size="sm"
                      onClick={() => startCheckout.mutate(p.id as (typeof PAID)[number])}
                      disabled={!p.hasStripePrice || startCheckout.isPending}
                      loading={startCheckout.isPending}
                      title={p.hasStripePrice ? undefined : "No Stripe price configured"}
                    >
                      Upgrade
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" disabled>
                      Free plan
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {(startCheckout.error as ApiError | undefined) && (
        <p className="text-sm text-destructive">{(startCheckout.error as ApiError).message}</p>
      )}
    </div>
  );
}
