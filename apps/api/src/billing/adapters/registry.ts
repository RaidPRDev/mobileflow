import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { paymentProcessors } from "../../db/schema.js";
import { decryptString } from "../../lib/crypto.js";
import type {
  AdapterFieldSchema,
  PaymentAdapter,
  ProcessorMode,
  SanitizedConfig,
  SanitizedCredentials,
} from "./base.js";
import {
  StripeAdapter,
  type StripeConfigBlob,
  type StripeCredentialsBlob,
} from "./stripe.js";
import {
  PayPalAdapter,
  type PayPalConfigBlob,
  type PayPalCredentialsBlob,
} from "./paypal.js";
import {
  ConnectPayAdapter,
  type ConnectPayConfigBlob,
  type ConnectPayCredentialsBlob,
} from "./connectpay.js";

// Provider id is the same enum the DB column uses. Expand as we add adapters.
export type ProviderId = "stripe" | "paypal" | "connectpay";

export interface AdapterDescriptor {
  id: ProviderId;
  displayName: string;
  credentialsSchema: AdapterFieldSchema;
  configSchema: AdapterFieldSchema;
}

// Static descriptors for the admin UI — these tell the page what to render
// even when nothing is configured yet.
export const ALL_ADAPTERS: AdapterDescriptor[] = [
  {
    id: "stripe",
    displayName: "Stripe",
    credentialsSchema: StripeAdapter.credentialsSchemaStatic(),
    configSchema: StripeAdapter.configSchemaStatic(),
  },
  {
    id: "paypal",
    displayName: "PayPal",
    credentialsSchema: PayPalAdapter.credentialsSchemaStatic(),
    configSchema: PayPalAdapter.configSchemaStatic(),
  },
  {
    id: "connectpay",
    displayName: "ConnectPay",
    credentialsSchema: ConnectPayAdapter.credentialsSchemaStatic(),
    configSchema: ConnectPayAdapter.configSchemaStatic(),
  },
];

export function adapterDescriptor(id: ProviderId): AdapterDescriptor | null {
  return ALL_ADAPTERS.find((a) => a.id === id) ?? null;
}

// ----- Active adapter resolution + cache -----

interface CacheEntry {
  // Used as a cheap invalidation key — when the DB row's updatedAt moves, we
  // rebuild. Avoids reading the encrypted blob on every request.
  signature: string;
  adapter: PaymentAdapter;
}

let cached: CacheEntry | null = null;

export function clearActiveAdapterCache(): void {
  cached = null;
}

export async function getActiveAdapter(): Promise<PaymentAdapter | null> {
  const [row] = await db
    .select()
    .from(paymentProcessors)
    .where(eq(paymentProcessors.enabled, true))
    .limit(1);
  if (!row) {
    cached = null;
    return null;
  }
  const signature = `${row.id}:${row.provider}:${row.mode}:${row.updatedAt.toISOString()}`;
  if (cached && cached.signature === signature) return cached.adapter;

  const creds = row.credentialsEnc
    ? (JSON.parse(decryptString(row.credentialsEnc)) as Record<string, unknown>)
    : {};
  const config = row.configEnc
    ? (JSON.parse(decryptString(row.configEnc)) as Record<string, unknown>)
    : {};

  let adapter: PaymentAdapter;
  switch (row.provider) {
    case "stripe":
      adapter = new StripeAdapter(
        row.mode as ProcessorMode,
        creds as StripeCredentialsBlob,
        config as StripeConfigBlob,
      );
      break;
    case "paypal":
      adapter = new PayPalAdapter(
        row.mode as ProcessorMode,
        creds as PayPalCredentialsBlob,
        config as PayPalConfigBlob,
      );
      break;
    case "connectpay":
      adapter = new ConnectPayAdapter(
        row.mode as ProcessorMode,
        creds as ConnectPayCredentialsBlob,
        config as ConnectPayConfigBlob,
      );
      break;
    default:
      // Exhaustive check — adding a new enum value forces a new case.
      throw new Error(`Unsupported payment processor: ${row.provider as string}`);
  }
  cached = { signature, adapter };
  return adapter;
}

// ----- Sanitization for the admin UI -----
//
// Secrets are stripped to a boolean `{ set: true }` flag (rendered as a
// "Configured" badge in the form) so the cleartext never leaves the server.
// Plain `string` fields are returned as-is so admins see what they pasted.

export function sanitizeCredentials(
  schema: AdapterFieldSchema,
  blob: Record<string, unknown>,
): SanitizedCredentials {
  const out: SanitizedCredentials = {};
  for (const field of schema.fields) {
    if (field.mode === "per-mode") {
      out[field.key] = {
        sandbox: presence(blob, field.key, "sandbox", field.type === "secret"),
        production: presence(blob, field.key, "production", field.type === "secret"),
      };
    } else {
      const v = (blob[field.key] as string | undefined) ?? undefined;
      out[field.key] = field.type === "secret" ? !!v : (v ?? "");
    }
  }
  return out;
}

export function sanitizeConfig(
  schema: AdapterFieldSchema,
  blob: Record<string, unknown>,
): SanitizedConfig {
  const out: SanitizedConfig = {};
  for (const field of schema.fields) {
    if (field.mode === "per-mode") {
      out[field.key] = {
        sandbox: readDottedFromMode(blob, "sandbox", field.key) ?? null,
        production: readDottedFromMode(blob, "production", field.key) ?? null,
      };
    } else {
      out[field.key] = readDotted(blob, field.key) ?? null;
    }
  }
  return out;
}

function presence(
  blob: Record<string, unknown>,
  key: string,
  mode: "sandbox" | "production",
  secret: boolean,
): string | boolean {
  // Credentials are stored as { keys: { sandbox: { publishableKey, ... }, production: { ... } } }
  // for Stripe. The schema field key is the inner field name (e.g. "publishableKey"),
  // so we look it up under keys[mode][key].
  const root = blob.keys as Record<string, Record<string, string | undefined>> | undefined;
  const v = root?.[mode]?.[key] ?? undefined;
  if (secret) return !!v;
  return v ?? "";
}

function readDotted(
  blob: Record<string, unknown>,
  dotted: string,
): string | null {
  // "prices.bohio" → blob.prices.bohio
  const parts = dotted.split(".");
  let cur: unknown = blob;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return null;
    }
  }
  return typeof cur === "string" ? cur : null;
}

function readDottedFromMode(
  blob: Record<string, unknown>,
  mode: "sandbox" | "production",
  dotted: string,
): string | null {
  // Config blob shape (Stripe): { prices: { sandbox: { bohio, … }, production: { … } } }
  // The field key is "prices.bohio"; we need to splice `mode` after the first segment.
  const parts = dotted.split(".");
  const head = parts[0];
  if (parts.length < 2 || !head) return null;
  const root = blob[head] as Record<string, unknown> | undefined;
  const inMode = root?.[mode] as Record<string, unknown> | undefined;
  if (!inMode) return null;
  let cur: unknown = inMode;
  for (const p of parts.slice(1)) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return null;
    }
  }
  return typeof cur === "string" ? cur : null;
}
