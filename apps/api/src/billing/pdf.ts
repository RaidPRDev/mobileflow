// Server-side PDF rendering for invoices and receipts. Layout follows the
// stripe-style mock the user provided: header (title + logo), customer info
// blocks, headline amount, line-items table, totals, optional payment history.
//
// pdfkit is purely programmatic — there's no HTML/CSS, just coordinate-based
// drawing. That's why this file has so many magic numbers; treat each section
// like a row in a layout grid you've drawn on paper.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";

// PAID stamp asset. Resolved relative to this module so the location is
// portable whether the API runs from `tsx src/...` (dev) or `node dist/...`
// (build). Cached on first use; reading 250KB off disk per invoice would be
// wasteful when most PDFs in a run share the same stamp.
const PAID_STAMP_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../assets/images/paid_stamp.png",
);
let _paidStampCache: Buffer | null = null;
function loadPaidStamp(): Buffer | null {
  if (_paidStampCache) return _paidStampCache;
  try {
    _paidStampCache = readFileSync(PAID_STAMP_PATH);
    return _paidStampCache;
  } catch {
    return null;
  }
}

// Brand / seller details. Defaults are used only when the admin hasn't filled
// in the Company page yet (company_info row missing or fields null).
const DEFAULT_SELLER: Seller = {
  name: "MobileFlow",
  legalName: "MobileFlow, Inc.",
  supportEmail: null,
  logo: null,
};

export interface SellerLogo {
  mime: "image/png" | "image/jpeg" | "image/svg+xml" | string;
  data: Buffer;
}

export interface Seller {
  name: string;
  legalName: string | null;
  supportEmail: string | null;
  logo: SellerLogo | null;
}

type CurrencyAmount = { amountCents: number; currency: string };

export interface PaymentSnapshot {
  id: string;
  processorInvoiceId: string;
  receiptNumber: string | null;
  amountCents: number;
  currency: string;
  status: "paid" | "open" | "uncollectible" | "void" | "draft" | "failed";
  paidAt: Date | null;
  createdAt: Date;
  customerName: string | null;
  customerEmail: string | null;
  customerAddressLine1: string | null;
  customerAddressLine2: string | null;
  customerCity: string | null;
  customerState: string | null;
  customerPostalCode: string | null;
  customerCountry: string | null;
  planName: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  paymentMethodType: string | null;
  paymentMethodBrand: string | null;
  paymentMethodLast4: string | null;
}

export function renderInvoicePdf(
  payment: PaymentSnapshot,
  seller: Seller | null,
  stream: NodeJS.WritableStream,
): void {
  const s = sellerOrDefault(seller);
  const doc = new PDFDocument({ size: "LETTER", margin: 56 });
  doc.pipe(stream);

  drawHeader(doc, "Invoice", s);
  drawIdsBlock(doc, [
    ["Invoice number", payment.processorInvoiceId],
    ["Date of issue", formatDate(payment.paidAt ?? payment.createdAt)],
    ["Date due", formatDate(payment.paidAt ?? payment.createdAt)],
  ]);
  drawSellerAndCustomer(doc, payment, s);
  drawHeadline(
    doc,
    `${formatMoney(payment)} due ${formatDate(payment.paidAt ?? payment.createdAt)}`,
  );
  drawLineItems(doc, payment);
  drawTotals(doc, payment, "Amount due");

  if (payment.status === "paid") {
    drawPaidStamp(doc);
  }

  doc.end();
}

export function renderReceiptPdf(
  payment: PaymentSnapshot,
  seller: Seller | null,
  stream: NodeJS.WritableStream,
): void {
  const s = sellerOrDefault(seller);
  const doc = new PDFDocument({ size: "LETTER", margin: 56 });
  doc.pipe(stream);

  drawHeader(doc, "Receipt", s);
  drawIdsBlock(doc, [
    ["Invoice number", payment.processorInvoiceId],
    ["Receipt number", payment.receiptNumber ?? "—"],
    ["Date paid", formatDate(payment.paidAt ?? payment.createdAt)],
  ]);
  drawSellerAndCustomer(doc, payment, s);
  drawHeadline(
    doc,
    `${formatMoney(payment)} paid on ${formatDate(payment.paidAt ?? payment.createdAt)}`,
  );
  drawLineItems(doc, payment);
  drawTotals(doc, payment, "Amount paid");
  drawPaymentHistory(doc, payment);

  if (payment.status === "paid") {
    drawPaidStamp(doc);
  }

  doc.end();
}

function sellerOrDefault(s: Seller | null): Seller {
  if (!s) return DEFAULT_SELLER;
  return {
    name: s.name?.trim() || DEFAULT_SELLER.name,
    legalName: s.legalName?.trim() || DEFAULT_SELLER.legalName,
    supportEmail: s.supportEmail?.trim() || DEFAULT_SELLER.supportEmail,
    logo: s.logo ?? null,
  };
}

// ----- sections -----

function drawHeader(doc: PDFKit.PDFDocument, title: string, seller: Seller) {
  doc.font("Helvetica-Bold").fontSize(24).fillColor("#111").text(title, 56, 56);
  drawLogo(doc, seller);
}

// Render the company logo in the top-right corner. PNG/JPG go straight into
// pdfkit's image embedder; SVGs are parsed by svg-to-pdfkit which emits
// path-level pdfkit calls. If no logo is configured we fall back to the
// initials of the seller's display name on a filled circle so the corner
// isn't blank.
function drawLogo(doc: PDFKit.PDFDocument, seller: Seller) {
  // Layout box for the logo: a 90×40 area anchored top-right. The image is
  // fit into this box preserving aspect ratio.
  const x = 460;
  const y = 52;
  const w = 90;
  const h = 40;

  if (seller.logo) {
    try {
      if (seller.logo.mime === "image/svg+xml") {
        const svg = seller.logo.data.toString("utf8");
        SVGtoPDF(doc, svg, x, y, { width: w, height: h, preserveAspectRatio: "xMaxYMid meet" });
        return;
      }
      // pdfkit handles PNG and JPG via the same image API; passing a Buffer
      // works for both.
      doc.image(seller.logo.data, x, y, { fit: [w, h], align: "right", valign: "center" });
      return;
    } catch {
      // Bad image — fall through to the initials placeholder so the PDF
      // still renders cleanly.
    }
  }

  // Fallback initials. Takes the first two letters of the seller name,
  // uppercased; "MobileFlow" → "MO".
  const initials = (seller.name.match(/[A-Za-z]/g) ?? [])
    .slice(0, 2)
    .join("")
    .toUpperCase() || "??";
  doc.save();
  doc.circle(x + w - 18, y + 18, 18).fillColor("#1d4ed8").fill();
  doc
    .fillColor("#fff")
    .font("Helvetica-Bold")
    .fontSize(initials.length === 1 ? 14 : 11)
    .text(initials, x + w - 30, y + 13, { width: 24, align: "center", lineBreak: false });
  doc.restore();
}

function drawIdsBlock(doc: PDFKit.PDFDocument, rows: Array<[string, string]>) {
  // Render each row with explicit x/y for BOTH label and value. pdfkit's
  // `continued: true` chains the internal cursor across calls, which
  // misbehaves when the next iteration passes explicit x/y — the second-row
  // text ends up vertically offset by the prior row's leading.
  let y = 100;
  for (const [label, value] of rows) {
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("#111")
      .text(label, 56, y, { width: 100, lineBreak: false });
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#111")
      .text(value, 160, y, { width: 380, lineBreak: false });
    y += 14;
  }
}

function drawSellerAndCustomer(doc: PDFKit.PDFDocument, p: PaymentSnapshot, seller: Seller) {
  const y = 200;
  // Left column — seller. Only lines that have content show up, so a missing
  // legal name / support email doesn't leave gaping holes.
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#111").text(seller.name, 56, y);
  doc.font("Helvetica").fontSize(9).fillColor("#444");
  let cur = y + 14;
  const sellerLines = [
    seller.legalName,
    seller.supportEmail ? `Support: ${seller.supportEmail}` : null,
  ].filter((s): s is string => !!s && s.trim().length > 0);
  for (const line of sellerLines) {
    doc.text(line, 56, cur);
    cur += 12;
  }

  // Right column — bill to.
  const billX = 320;
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#111").text("Bill to", billX, y);
  doc.font("Helvetica").fontSize(9).fillColor("#444");
  let bcur = y + 14;
  const billLines = [
    p.customerName,
    p.customerAddressLine1,
    p.customerAddressLine2,
    composeCityLine(p),
    p.customerCountry,
    p.customerEmail,
  ].filter((s): s is string => !!s && s.trim().length > 0);
  for (const line of billLines) {
    doc.text(line, billX, bcur);
    bcur += 12;
  }
}

function composeCityLine(p: PaymentSnapshot): string | null {
  const parts = [p.customerCity, p.customerState, p.customerPostalCode]
    .filter((s): s is string => !!s && s.trim().length > 0);
  return parts.length > 0 ? parts.join(", ") : null;
}

function drawHeadline(doc: PDFKit.PDFDocument, text: string) {
  doc.font("Helvetica-Bold").fontSize(14).fillColor("#111").text(text, 56, 290);
}

function drawLineItems(doc: PDFKit.PDFDocument, p: PaymentSnapshot) {
  const top = 332;
  // Header row.
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#444");
  doc.text("Description", 56, top);
  doc.text("Qty", 360, top, { width: 40, align: "right" });
  doc.text("Unit price", 410, top, { width: 70, align: "right" });
  doc.text("Amount", 486, top, { width: 70, align: "right" });
  doc
    .moveTo(56, top + 14)
    .lineTo(556, top + 14)
    .strokeColor("#ddd")
    .stroke();

  // Single line item — the plan + period.
  const itemY = top + 22;
  doc.font("Helvetica").fontSize(10).fillColor("#111");
  doc.text(p.planName ?? "Subscription", 56, itemY);
  if (p.periodStart && p.periodEnd) {
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#666")
      .text(
        `${formatDate(p.periodStart, { short: true })}–${formatDate(p.periodEnd, { short: true })}`,
        56,
        itemY + 13,
      );
  }
  doc.font("Helvetica").fontSize(10).fillColor("#111");
  doc.text("1", 360, itemY, { width: 40, align: "right" });
  doc.text(formatMoney(p), 410, itemY, { width: 70, align: "right" });
  doc.text(formatMoney(p), 486, itemY, { width: 70, align: "right" });
}

function drawTotals(doc: PDFKit.PDFDocument, p: PaymentSnapshot, finalLabel: string) {
  const top = 420;
  doc.font("Helvetica").fontSize(10).fillColor("#111");
  doc.text("Subtotal", 360, top, { width: 120, align: "right" });
  doc.text(formatMoney(p), 486, top, { width: 70, align: "right" });
  doc.text("Total", 360, top + 16, { width: 120, align: "right" });
  doc.text(formatMoney(p), 486, top + 16, { width: 70, align: "right" });
  doc.font("Helvetica-Bold").text(finalLabel, 360, top + 32, { width: 120, align: "right" });
  doc.text(`${formatMoney(p)} ${p.currency.toUpperCase()}`, 486, top + 32, {
    width: 70,
    align: "right",
  });
}

function drawPaymentHistory(doc: PDFKit.PDFDocument, p: PaymentSnapshot) {
  const top = 500;
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#111").text("Payment history", 56, top);
  const hdrY = top + 22;
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#444");
  doc.text("Payment method", 56, hdrY);
  doc.text("Date", 260, hdrY);
  doc.text("Amount paid", 360, hdrY, { width: 100, align: "right" });
  doc.text("Receipt number", 470, hdrY, { width: 90, align: "right" });
  doc
    .moveTo(56, hdrY + 14)
    .lineTo(556, hdrY + 14)
    .strokeColor("#ddd")
    .stroke();

  const rowY = hdrY + 22;
  doc.font("Helvetica").fontSize(10).fillColor("#111");
  doc.text(formatPaymentMethod(p), 56, rowY);
  doc.text(formatDate(p.paidAt ?? p.createdAt), 260, rowY);
  doc.text(formatMoney(p), 360, rowY, { width: 100, align: "right" });
  doc.text(p.receiptNumber ?? "—", 470, rowY, { width: 90, align: "right" });
}

function drawPaidStamp(doc: PDFKit.PDFDocument) {
  // The stamp is a square PNG with a transparent background. Park it in the
  // bottom-right corner of the page — well below totals on both invoice
  // (totals end ~y=452) and receipt (payment history ends ~y=560), so it
  // never crashes through Bill To, the seller block, or the line items.
  // -8° tilt sells the "rubber stamped" effect without needing a
  // pre-rotated asset.
  const stamp = loadPaidStamp();
  if (!stamp) return;
  const size = 110;
  const x = 410;
  const y = 600;
  doc.save();
  doc.rotate(-8, { origin: [x + size / 2, y + size / 2] });
  doc.image(stamp, x, y, { width: size, height: size });
  doc.restore();
}

// ----- formatters -----

function formatMoney(p: CurrencyAmount): string {
  return (p.amountCents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: p.currency || "USD",
  });
}

function formatDate(d: Date | null, opts?: { short?: boolean }): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", {
    month: opts?.short ? "short" : "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatPaymentMethod(p: PaymentSnapshot): string {
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
    default:
      return "—";
  }
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}
