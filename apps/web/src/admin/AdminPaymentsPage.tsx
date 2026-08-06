import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Badge, Combobox, type ComboboxOption, Input, Loading } from "@mobileflow/ui";
import { Download } from "lucide-react";
import { api, type AdminPaymentRow } from "../api/client";
import { RowActionsButton, RowContextMenu, type RowAction } from "../components/RowActions";
import { allowNativeContextMenu } from "../lib/rowInteractions";

// Cross-org payments ledger for superadmins. Read-only — the PDF downloads
// reuse the per-org endpoints (those let superadmins through automatically).

type ProviderFilter = "all" | "stripe" | "paypal" | "connectpay";
type StatusFilter = "all" | "paid" | "failed" | "open" | "void" | "uncollectible" | "draft";

const PROVIDER_OPTIONS: ComboboxOption<ProviderFilter>[] = [
  { value: "all", label: "All" },
  { value: "stripe", label: "Stripe" },
  { value: "paypal", label: "PayPal" },
  { value: "connectpay", label: "ConnectPay" },
];

const STATUS_OPTIONS: ComboboxOption<StatusFilter>[] = [
  { value: "all", label: "All" },
  { value: "paid", label: "Paid" },
  { value: "failed", label: "Failed" },
  { value: "open", label: "Open" },
  { value: "void", label: "Void" },
  { value: "uncollectible", label: "Uncollectible" },
  { value: "draft", label: "Draft" },
];

export function AdminPaymentsPage() {
  const q = useQuery({
    queryKey: ["admin", "payments"],
    queryFn: () => api.admin.payments(),
  });

  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState<ProviderFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");

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
          <div className="settings-field" style={{ minWidth: 160 }}>
            <label className="settings-field__label" htmlFor="payments-filter-provider">
              Provider
            </label>
            <Combobox<ProviderFilter>
              id="payments-filter-provider"
              value={provider}
              onChange={setProvider}
              options={PROVIDER_OPTIONS}
              ariaLabel="Filter by provider"
            />
          </div>
          <div className="settings-field" style={{ minWidth: 160 }}>
            <label className="settings-field__label" htmlFor="payments-filter-status">
              Status
            </label>
            <Combobox<StatusFilter>
              id="payments-filter-status"
              value={status}
              onChange={setStatus}
              options={STATUS_OPTIONS}
              ariaLabel="Filter by status"
            />
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
                  <RowContextMenu key={p.id} actions={rowActions(p)}>
                    <tr>
                      <td>
                        <Link
                          className="link"
                          to={`/org/${p.orgId}/settings/subscriptions/invoices/${p.id}`}
                          onContextMenu={allowNativeContextMenu}
                        >
                          {formatDate(p.paidAt ?? p.createdAt)}
                        </Link>
                      </td>
                      <td>
                        <Link
                          className="link"
                          to={`/admin/orgs/${p.orgId}`}
                          onContextMenu={allowNativeContextMenu}
                        >
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
                      <td className="payments-table__actions">
                        <RowActionsButton
                          actions={rowActions(p)}
                          ariaLabel={`Actions for invoice ${p.processorInvoiceId}`}
                        />
                      </td>
                    </tr>
                  </RowContextMenu>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// One list feeds the row's ⋮ button and its right-click menu. Both PDFs are
// plain GETs, so opening them in a new tab is all the "download" needs to be —
// the endpoints send Content-Disposition: attachment.
function rowActions(p: AdminPaymentRow): RowAction[] {
  const icon = <Download size={14} aria-hidden />;
  return [
    {
      label: "Download Invoice",
      icon,
      onSelect: () => openPdf(api.invoicePdfUrl(p.orgId, p.id)),
    },
    {
      label: "Download Receipt",
      icon,
      onSelect: () => openPdf(api.receiptPdfUrl(p.orgId, p.id)),
    },
  ];
}

function openPdf(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
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
