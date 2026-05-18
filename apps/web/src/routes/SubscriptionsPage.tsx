import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Combobox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@mobileflow/ui";
import { CreditCard } from "lucide-react";
import {
  ApiError,
  api,
  type BillingInfoRow,
  type PaymentMethodRow,
  type PaymentRow,
} from "../api/client";
import { COUNTRIES, countryName } from "./subscriptions/countries";
import { TAX_ID_TYPES, taxIdLabel } from "./subscriptions/taxIds";
import { PaymentMethodForm } from "./subscriptions/PaymentMethodForm";

const PAID = ["bohio", "yucayeque", "cacique"] as const;
type PaidPlan = (typeof PAID)[number];

export function SubscriptionsPage() {
  const { orgId } = useParams();
  const [params, setParams] = useSearchParams();
  const checkout = params.get("checkout");

  const subQ = useQuery({
    queryKey: ["sub", orgId],
    queryFn: () => api.getSubscription(orgId!),
    enabled: !!orgId,
  });
  const plansQ = useQuery({
    queryKey: ["billing-plans"],
    queryFn: () => api.listBillingPlans(),
  });
  const billingQ = useQuery({
    queryKey: ["billing-info", orgId],
    queryFn: () => api.getBillingInfo(orgId!),
    enabled: !!orgId,
  });
  const pmQ = useQuery({
    queryKey: ["payment-method", orgId],
    queryFn: () => api.getPaymentMethod(orgId!),
    enabled: !!orgId,
  });
  const paymentsQ = useQuery({
    queryKey: ["payments", orgId],
    queryFn: () => api.listPayments(orgId!),
    enabled: !!orgId,
  });

  useEffect(() => {
    if (checkout) {
      const t = setTimeout(() => {
        const next = new URLSearchParams(params);
        next.delete("checkout");
        setParams(next, { replace: true });
      }, 5000);
      return () => clearTimeout(t);
    }
  }, [checkout, params, setParams]);

  const currentPlan = subQ.data?.planId ?? "naboria";
  const currentPlanInfo = plansQ.data?.find((p) => p.id === currentPlan);
  const upgradeTarget = plansQ.data?.find(
    (p) => (PAID as readonly string[]).includes(p.id) && p.id !== currentPlan && p.hasStripePrice,
  );

  if (!orgId) return null;

  return (
    <div className="settings-page">
      <h1 className="page-title">Subscriptions</h1>

      {checkout === "success" && (
        <p className="settings-banner is-success">
          Subscription updated. It may take a few seconds to reflect here.
        </p>
      )}
      {checkout === "cancel" && (
        <p className="settings-banner">Checkout was cancelled.</p>
      )}

      <PlanRow
        orgId={orgId}
        currentPlanId={currentPlan}
        currentPlanName={currentPlanInfo?.name ?? currentPlan}
        currentPlanPriceCents={currentPlanInfo?.priceCents ?? 0}
        upgradeTarget={upgradeTarget?.name ?? null}
        plans={plansQ.data ?? []}
      />

      <hr className="settings-divider" />

      <BillingDetailsRow orgId={orgId} info={billingQ.data ?? null} pm={pmQ.data ?? null} />

      <hr className="settings-divider" />

      <PaymentsRow payments={paymentsQ.data ?? []} loading={paymentsQ.isLoading} />
    </div>
  );
}

// ─── Plan ────────────────────────────────────────────────────────────────────

function PlanRow({
  orgId,
  currentPlanId,
  currentPlanName,
  currentPlanPriceCents,
  upgradeTarget,
  plans,
}: {
  orgId: string;
  currentPlanId: string;
  currentPlanName: string;
  currentPlanPriceCents: number;
  upgradeTarget: string | null;
  plans: { id: string; name: string; priceCents: number; hasStripePrice: boolean }[];
}) {
  const [showDialog, setShowDialog] = useState(false);

  return (
    <section className="settings-row">
      <div className="settings-row__label">Plan</div>
      <div className="settings-row__content">
        <div className="plan-summary">
          <div>
            <div className="plan-summary__name">MobileFlow {currentPlanName}</div>
            <div className="plan-summary__price">{formatPrice(currentPlanPriceCents)}</div>
          </div>
          <Button variant="outline" onClick={() => setShowDialog(true)}>
            Change Plan
          </Button>
        </div>
        {upgradeTarget && (
          <p className="plan-upgrade-hint">
            <span className="link" role="button" onClick={() => setShowDialog(true)}>
              Upgrade to {upgradeTarget} plan
            </span>
          </p>
        )}
      </div>

      <ChangePlanDialog
        open={showDialog}
        onOpenChange={setShowDialog}
        orgId={orgId}
        currentPlanId={currentPlanId}
        plans={plans}
      />
    </section>
  );
}

function ChangePlanDialog({
  open,
  onOpenChange,
  orgId,
  currentPlanId,
  plans,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  orgId: string;
  currentPlanId: string;
  plans: { id: string; name: string; priceCents: number; hasStripePrice: boolean }[];
}) {
  const startCheckout = useMutation({
    mutationFn: (planId: PaidPlan) => api.startCheckout(orgId, planId),
    onSuccess: ({ url }) => (window.location.href = url),
  });
  const openPortal = useMutation({
    mutationFn: () => api.openBillingPortal(orgId),
    onSuccess: ({ url }) => (window.location.href = url),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Choose a plan</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="plans-grid">
            {plans.map((p) => {
              const isCurrent = p.id === currentPlanId;
              const isPaid = (PAID as readonly string[]).includes(p.id);
              return (
                <div
                  key={p.id}
                  className={`plan-tile${isCurrent ? " is-current" : ""}`}
                >
                  <div className="plan-tile__name">{p.name}</div>
                  <div className="plan-tile__price">{formatPrice(p.priceCents)}</div>
                  <div className="plan-tile__action">
                    {isCurrent ? (
                      <Button size="sm" variant="outline" disabled>
                        Current plan
                      </Button>
                    ) : isPaid ? (
                      <Button
                        size="sm"
                        onClick={() => startCheckout.mutate(p.id as PaidPlan)}
                        disabled={!p.hasStripePrice || startCheckout.isPending}
                        loading={startCheckout.isPending}
                      >
                        Choose
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" disabled>
                        Free plan
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {startCheckout.error instanceof ApiError && (
            <p className="text-error">{startCheckout.error.message}</p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => openPortal.mutate()} loading={openPortal.isPending}>
            Manage in Stripe portal
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Billing details ─────────────────────────────────────────────────────────

function BillingDetailsRow({
  orgId,
  info,
  pm,
}: {
  orgId: string;
  info: BillingInfoRow | null;
  pm: PaymentMethodRow | null;
}) {
  const [editing, setEditing] = useState<"info" | "method" | null>(null);

  return (
    <section className="settings-row">
      <div className="settings-row__label">Billing details</div>
      <div className="settings-row__content">
        <div className="billing-card">
          <div className="billing-subrow">
            <div className="billing-subrow__label">Billing info</div>
            <div className="billing-subrow__body">
              {editing === "info" ? (
                <BillingInfoForm
                  orgId={orgId}
                  initial={info}
                  onDone={() => setEditing(null)}
                />
              ) : (
                <BillingInfoSummary info={info} onEdit={() => setEditing("info")} />
              )}
            </div>
          </div>

          <hr className="billing-card__sep" />

          <div className="billing-subrow">
            <div className="billing-subrow__label">Payment method</div>
            <div className="billing-subrow__body">
              {editing === "method" ? (
                <PaymentMethodForm
                  orgId={orgId}
                  onSaved={() => setEditing(null)}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <PaymentMethodSummary pm={pm} onEdit={() => setEditing("method")} />
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function BillingInfoSummary({
  info,
  onEdit,
}: {
  info: BillingInfoRow | null;
  onEdit: () => void;
}) {
  return (
    <div className="billing-summary">
      <div className="billing-summary__cells">
        <div className="billing-summary__cell">
          <div className="billing-summary__key">Customer name</div>
          <div className="billing-summary__val">{info?.fullName || "—"}</div>
        </div>
        <div className="billing-summary__cell">
          <div className="billing-summary__key">Address</div>
          <div className="billing-summary__val">
            {info?.addressLine1 ? info.addressLine1 : "—"}
          </div>
        </div>
        <div className="billing-summary__cell">
          <div className="billing-summary__key">Tax ID/VAT</div>
          <div className="billing-summary__val">
            {info?.taxIdValue ? `${taxIdLabel(info.taxIdType)} ${info.taxIdValue}` : "--"}
          </div>
        </div>
      </div>
      <button className="link billing-summary__edit" type="button" onClick={onEdit}>
        Edit
      </button>
    </div>
  );
}

function BillingInfoForm({
  orgId,
  initial,
  onDone,
}: {
  orgId: string;
  initial: BillingInfoRow | null;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [fullName, setFullName] = useState(initial?.fullName ?? "");
  const [country, setCountry] = useState(initial?.country ?? "US");
  const [line1, setLine1] = useState(initial?.addressLine1 ?? "");
  const [line2, setLine2] = useState(initial?.addressLine2 ?? "");
  const [city, setCity] = useState(initial?.city ?? "");
  const [state, setState] = useState(initial?.state ?? "");
  const [postalCode, setPostalCode] = useState(initial?.postalCode ?? "");
  const [taxIdType, setTaxIdType] = useState(initial?.taxIdType ?? "");
  const [taxIdValue, setTaxIdValue] = useState(initial?.taxIdValue ?? "");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.putBillingInfo(orgId, {
        fullName: fullName.trim() || null,
        country: country || null,
        addressLine1: line1.trim() || null,
        addressLine2: line2.trim() || null,
        city: city.trim() || null,
        state: state.trim() || null,
        postalCode: postalCode.trim() || null,
        taxIdType: taxIdType || null,
        taxIdValue: taxIdValue.trim() || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["billing-info", orgId] });
      onDone();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Save failed"),
  });

  return (
    <div className="stack-sm">
      <div className="settings-field">
        <label className="settings-field__label" htmlFor="bi-name">Full name</label>
        <Input id="bi-name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
      </div>
      <div className="settings-field">
        <label className="settings-field__label">Country or region</label>
        <Combobox
          value={country}
          onChange={setCountry}
          options={COUNTRIES.map((c) => ({ value: c.code, label: c.name }))}
          ariaLabel="Country or region"
        />
      </div>
      <div className="settings-field">
        <label className="settings-field__label" htmlFor="bi-line1">Address line 1</label>
        <Input id="bi-line1" value={line1} onChange={(e) => setLine1(e.target.value)} />
      </div>
      <div className="settings-field">
        <label className="settings-field__label" htmlFor="bi-line2">Address line 2</label>
        <Input
          id="bi-line2"
          value={line2}
          onChange={(e) => setLine2(e.target.value)}
          placeholder="Apt., suite, unit number, etc. (optional)"
        />
      </div>
      <div className="settings-field">
        <label className="settings-field__label" htmlFor="bi-city">City</label>
        <Input id="bi-city" value={city} onChange={(e) => setCity(e.target.value)} />
      </div>
      <div className="row gap-md">
        <div className="settings-field grow">
          <label className="settings-field__label" htmlFor="bi-state">State</label>
          <Input id="bi-state" value={state} onChange={(e) => setState(e.target.value)} />
        </div>
        <div className="settings-field grow">
          <label className="settings-field__label" htmlFor="bi-zip">ZIP code</label>
          <Input id="bi-zip" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
        </div>
      </div>
      <div className="row gap-md">
        <div className="settings-field grow">
          <label className="settings-field__label">Tax ID type</label>
          <Combobox
            value={taxIdType || undefined}
            onChange={(v) => setTaxIdType(v)}
            options={TAX_ID_TYPES.map((t) => ({ value: t.value, label: t.label }))}
            placeholder="Select…"
            ariaLabel="Tax ID type"
          />
        </div>
        <div className="settings-field grow">
          <label className="settings-field__label" htmlFor="bi-taxid">Tax ID / VAT</label>
          <Input id="bi-taxid" value={taxIdValue} onChange={(e) => setTaxIdValue(e.target.value)} />
        </div>
      </div>

      {error && <p className="text-error">{error}</p>}

      <div className="row">
        <Button onClick={() => save.mutate()} disabled={save.isPending} loading={save.isPending}>
          Save
        </Button>
        <Button variant="outline" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function PaymentMethodSummary({
  pm,
  onEdit,
}: {
  pm: PaymentMethodRow | null;
  onEdit: () => void;
}) {
  return (
    <div className="billing-summary">
      <div className="payment-method-display">
        {pm && pm.type === "card" && pm.brand && pm.last4 ? (
          <>
            <span className="card-brand-icon"><CreditCard size={18} /></span>
            <span className="payment-method-display__brand">{pm.brand}</span>
            <span className="payment-method-display__last4">•••• {pm.last4}</span>
            {pm.expMonth && pm.expYear && (
              <span className="payment-method-display__exp">
                {String(pm.expMonth).padStart(2, "0")}/{String(pm.expYear).slice(-2)}
              </span>
            )}
          </>
        ) : (
          <span className="payment-method-display__none">No payment method on file</span>
        )}
      </div>
      <button className="link billing-summary__edit" type="button" onClick={onEdit}>
        Edit
      </button>
    </div>
  );
}

// ─── Payments ────────────────────────────────────────────────────────────────

function PaymentsRow({
  payments,
  loading,
}: {
  payments: PaymentRow[];
  loading: boolean;
}) {
  return (
    <section className="settings-row">
      <div className="settings-row__label">Payments</div>
      <div className="settings-row__content">
        <div className="payments-table-wrap">
          <table className="payments-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th>Amount</th>
                <th>Status</th>
                <th aria-label="Invoice" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="payments-table__status">Loading…</td>
                </tr>
              ) : payments.length === 0 ? (
                <tr>
                  <td colSpan={5} className="payments-table__status">No payments yet.</td>
                </tr>
              ) : (
                payments.map((p) => (
                  <tr key={p.id}>
                    <td>{new Date(p.paidAt ?? p.createdAt).toLocaleDateString()}</td>
                    <td>{p.description ?? p.stripeInvoiceId}</td>
                    <td>
                      {(p.amountCents / 100).toLocaleString(undefined, {
                        style: "currency",
                        currency: p.currency || "USD",
                      })}
                    </td>
                    <td>
                      <span className={`payments-status is-${p.status}`}>{p.status}</span>
                    </td>
                    <td>
                      {p.invoicePdfUrl ? (
                        <a className="link" href={p.invoicePdfUrl} target="_blank" rel="noreferrer">
                          PDF
                        </a>
                      ) : p.hostedInvoiceUrl ? (
                        <a className="link" href={p.hostedInvoiceUrl} target="_blank" rel="noreferrer">
                          View
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function formatPrice(cents: number): string {
  if (!cents) return "Free";
  return `$${(cents / 100).toFixed(0)}/mo`;
}
