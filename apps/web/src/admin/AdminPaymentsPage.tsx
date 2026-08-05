import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Badge, Input, Loading } from "@mobileflow/ui";
import { Download } from "lucide-react";
import { api, type AdminPaymentRow } from "../api/client";

// Cross-org payments ledger for superadmins. Read-only — the PDF downloads
// reuse the per-org endpoints (those let superadmins through automatically).

export function AdminPaymentsPage() {
  const q = useQuery({
    queryKey: ["admin", "payments"],
    queryFn: () => api.admin.payments(),
  });

  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");

  const rows = useMemo(() => {
    const data = q.data ?? [];
    const lower = search.trim().toLowerCase();
    return data.filter((r) => {
      if (provider !== "all" && r.paymentProvider !== provider) return false;
      if (status !== "all" && r.status !== status) return false;
      if (lower) {
        const hay = `${r.orgName} ${r.orgSlug} ${r.customerName ?? ""} ${
          r.processorInvoiceId
        } ${r.receiptNumber ?? ""}`.toLowerCase();
        if (!hay.includes(lower)) return false;
      }
      return true;
    });
  }, [q.data, search, provider, status]);

  const totalCents = rows
    .filter((r) => r.status === "paid")
    .reduce((sum, r) => sum + r.amountCents, 0);

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Payments</h1>
      </div>
      <p className="text-help">
        Every invoice across every organization. Up to the latest 500 records.
      </p>

      <div className="page-section stack-sm">
        <div className="row gap-md" style={{ alignItems: "end", flexWrap: "wrap" }}>
          <div className="settings-field grow" style={{ minWidth: 220 }}>
            <label className="settings-field__label">Search</label>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Org, customer, invoice / receipt #"
            />
          </div>
          <div className="settings-field">
            <label className="settings-field__label">Provider</label>
            <select
              className="settings-select"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="all">All</option>
              <option value="stripe">Stripe</option>
              <option value="paypal">PayPal</option>
              <option value="connectpay">ConnectPay</option>
            </select>
          </div>
          <div className="settings-field">
            <label className="settings-field__label">Status</label>
            <select
              className="settings-select"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="all">All</option>
              <option value="paid">Paid</option>
              <option value="failed">Failed</option>
              <option value="open">Open</option>
              <option value="void">Void</option>
              <option value="uncollectible">Uncollectible</option>
              <option value="draft">Draft</option>
            </select>
          </div>
          <div className="text-help" style={{ marginLeft: "auto" }}>
            {rows.length} {rows.length === 1 ? "row" : "rows"} · {formatMoney(totalCents, "USD")} paid
          </div>
        </div>

        <div className="payments-table-wrap">
          <table className="payments-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Organization</th>
                <th>Plan</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Provider</th>
                <th>Method</th>
                <th>Receipt #</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {q.isLoading ? (
                <tr>
                  <td colSpan={9} className="payments-table__status">
                    <Loading />
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="payments-table__status">No payments match.</td>
                </tr>
              ) : (
                rows.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link
                        className="link"
                        to={`/org/${p.orgId}/settings/subscriptions/invoices/${p.id}`}
                      >
                        {formatDate(p.paidAt ?? p.createdAt)}
                      </Link>
                    </td>
                    <td>
                      <Link className="link" to={`/admin/orgs/${p.orgId}`}>
                        {p.orgName}
                      </Link>
                    </td>
                    <td>{p.planName ?? "—"}</td>
                    <td>{formatMoney(p.amountCents, p.currency)}</td>
                    <td>
                      <span className={`payments-status is-${p.status}`}>{p.status}</span>
                    </td>
                    <td>
                      <Badge variant="outline">{p.paymentProvider}</Badge>
                    </td>
                    <td>{formatPaymentMethod(p)}</td>
                    <td>{p.receiptNumber ?? "—"}</td>
                    <td>
                      <a
                        className="link"
                        title="Download invoice PDF"
                        href={api.invoicePdfUrl(p.orgId, p.id)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Download size={13} aria-hidden /> Invoice
                      </a>
                      {" · "}
                      <a
                        className="link"
                        title="Download receipt PDF"
                        href={api.receiptPdfUrl(p.orgId, p.id)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Receipt
                      </a>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function formatMoney(cents: number, currency: string): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: currency || "USD",
  });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatPaymentMethod(p: AdminPaymentRow): string {
  if (p.paymentMethodType === "card" && p.paymentMethodBrand && p.paymentMethodLast4) {
    return `${capitalize(p.paymentMethodBrand)} •••• ${p.paymentMethodLast4}`;
  }
  switch (p.paymentMethodType) {
    case "paypal":
      return "PayPal";
    case "bank":
    case "us_bank_account":
      return "Bank";
    case "venmo":
      return "Venmo";
    case null:
    case undefined:
      return "—";
    default:
      return p.paymentMethodType;
  }
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}
