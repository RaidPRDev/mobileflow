import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, ExternalLink } from "lucide-react";
import { Button, Loading } from "@mobileflow/ui";
import { api, type PaymentDetail } from "../api/client";

// In-app invoice viewer for a single payment. The Stripe hosted page is the
// visual reference: amount + status icon up top, summary card with invoice
// number/date/method, two download buttons, and an outbound link to the
// processor for sanity-checking the underlying transaction.
export function InvoicePage() {
  const { orgId, paymentId } = useParams();
  const q = useQuery({
    queryKey: ["payment", orgId, paymentId],
    queryFn: () => api.getPayment(orgId!, paymentId!),
    enabled: !!orgId && !!paymentId,
  });

  if (!orgId || !paymentId) return null;

  if (q.isLoading) {
    return (
      <p className="text-help">
        <Loading />
      </p>
    );
  }
  if (q.isError || !q.data) {
    return <p className="text-error">Payment not found.</p>;
  }
  const p = q.data;

  return (
    <div className="settings-page invoice-page">
      <div className="invoice-back">
        <Link to={`/org/${orgId}/settings/subscriptions`} className="link">
          <ArrowLeft size={14} /> Back to subscriptions
        </Link>
      </div>

      <div className="invoice-card">
        <div className="invoice-card__head">
          <span className="invoice-card__status-icon" aria-hidden>
            <CheckCircle2 size={28} color="#16a34a" />
          </span>
          <div className="invoice-card__title">Invoice {p.status === "paid" ? "paid" : p.status}</div>
          <div className="invoice-card__amount">{formatMoney(p.amountCents, p.currency)}</div>
        </div>

        <dl className="invoice-card__rows">
          <Row label="Invoice number" value={p.processorInvoiceId} />
          <Row label="Receipt number" value={p.receiptNumber ?? "—"} />
          <Row
            label="Payment date"
            value={formatDate(p.paidAt ?? p.createdAt)}
          />
          <Row label="Payment method" value={formatPaymentMethod(p)} />
          {p.planName && <Row label="Plan" value={p.planName} />}
          {p.periodStart && p.periodEnd && (
            <Row
              label="Period"
              value={`${formatDate(p.periodStart)} – ${formatDate(p.periodEnd)}`}
            />
          )}
        </dl>

        <div className="invoice-card__actions">
          <a
            className="btn btn--outline"
            href={api.invoicePdfUrl(orgId, paymentId)}
            target="_blank"
            rel="noreferrer"
          >
            Download invoice
          </a>
          <a
            className="btn btn--primary"
            href={api.receiptPdfUrl(orgId, paymentId)}
            target="_blank"
            rel="noreferrer"
          >
            Download receipt
          </a>
        </div>

        {externalLinkFor(p) && (
          <p className="invoice-card__external">
            <a
              href={externalLinkFor(p)!}
              target="_blank"
              rel="noreferrer"
              className="link"
            >
              View on {processorLabel(p.paymentProvider)} <ExternalLink size={11} />
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="invoice-card__row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatMoney(cents: number, currency: string): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: currency || "USD",
  });
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatPaymentMethod(p: PaymentDetail): string {
  if (p.paymentMethodType === "card" && p.paymentMethodBrand && p.paymentMethodLast4) {
    return `${capitalize(p.paymentMethodBrand)} •••• ${p.paymentMethodLast4}`;
  }
  switch (p.paymentMethodType) {
    case "paypal":
      return "PayPal account";
    case "bank":
    case "us_bank_account":
      return "Bank account";
    case "venmo":
      return "Venmo";
    case null:
    case undefined:
      return "—";
    default:
      return p.paymentMethodType;
  }
}

function processorLabel(p: string): string {
  if (p === "stripe") return "Stripe";
  if (p === "paypal") return "PayPal";
  if (p === "connectpay") return "ConnectPay";
  return p;
}

// Outbound link to the processor's own dashboard, when we have a meaningful
// one. Stripe has a hostedInvoiceUrl per invoice; PayPal/ConnectPay don't
// expose a stable per-transaction consumer URL, so we link to the merchant
// dashboard entry point so the org admin can search there manually.
function externalLinkFor(p: PaymentDetail): string | null {
  if (p.hostedInvoiceUrl) return p.hostedInvoiceUrl;
  if (p.paymentProvider === "paypal") {
    return "https://www.paypal.com/activity/";
  }
  return null;
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}
