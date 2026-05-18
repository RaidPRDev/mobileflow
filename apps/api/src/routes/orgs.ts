import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { organizations } from "../db/schema.js";
import { requireOrgMember, requireUser } from "../auth/middleware.js";
import { sanitizeLabel } from "../lib/sanitize.js";

// Restrict data-URL icons to common raster MIME types (SVG excluded — it can
// embed JavaScript and become an XSS vector when rendered from an
// attacker-controlled data URL). Matches the policy in apps/api/src/routes/apps.ts.
const ICON_DATA_URL_MAX = 700_000;
const ICON_DATA_MIME_RE = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i;
const ICON_HTTP_URL_MAX = 2_000;
const ICON_HTTP_URL_RE = /^https?:\/\//i;

const IconUrlSchema = z.string().superRefine((v, ctx) => {
  if (ICON_HTTP_URL_RE.test(v)) {
    if (v.length > ICON_HTTP_URL_MAX) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Icon URL is too long" });
    }
    return;
  }
  if (ICON_DATA_MIME_RE.test(v)) {
    if (v.length > ICON_DATA_URL_MAX) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Icon image is too large" });
    }
    return;
  }
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "Icon must be an http(s) URL or a base64 data URL of type png/jpeg/gif/webp/bmp",
  });
});

// Trim happens inside the schema so what we persist matches what we validated —
// otherwise a caller could pad with whitespace to bypass length intent.
// sanitizeLabel additionally strips C0/C1 controls and bidi-override codepoints
// so a copy-pasted name with invisible "trojan source" bytes can't sneak in.
const OrgNameSchema = z
  .string()
  .max(300) // pre-trim hard cap to bound parse work on hostile input
  .transform((s) => sanitizeLabel(s).trim())
  .pipe(
    z
      .string()
      .min(1, "Organization name is required")
      .max(120, "Organization name must be 120 characters or fewer"),
  );

const OrgDescriptionSchema = z
  .string()
  .max(2_000)
  .transform((s) => sanitizeLabel(s).trim())
  .pipe(z.string().max(500, "Description must be 500 characters or fewer"))
  // Treat the empty string as "clear" — same shape as `null`. The handler
  // below also normalises null/undefined; this just keeps the wire format
  // friendly for clients that send "" instead of null.
  .transform((s) => (s.length === 0 ? null : s));

const OrgBillingEmailSchema = z
  .string()
  .max(500)
  .transform((s) => s.trim())
  // Email is optional: empty string maps to null (clear). When set, run the
  // email check on the trimmed value.
  .transform((s) => (s.length === 0 ? null : s))
  .pipe(
    z
      .union([
        z.null(),
        z.string().email("Billing email must be a valid email address").max(254),
      ]),
  );

const PatchBody = z
  .object({
    name: OrgNameSchema.optional(),
    iconUrl: IconUrlSchema.nullable().optional(),
    description: OrgDescriptionSchema.nullable().optional(),
    billingEmail: OrgBillingEmailSchema.nullable().optional(),
  })
  .strict();

export async function orgsRoutes(server: FastifyInstance) {
  server.addHook("preHandler", requireUser);

  server.get<{ Params: { orgId: string } }>("/orgs/:orgId", async (req, reply) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;
    const [row] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, req.params.orgId))
      .limit(1);
    if (!row) return reply.notFound();
    return row;
  });

  server.patch<{ Params: { orgId: string } }>("/orgs/:orgId", async (req, reply) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;
    const body = PatchBody.parse(req.body);
    if (Object.keys(body).length === 0) {
      const [row] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, req.params.orgId))
        .limit(1);
      return row;
    }
    const [updated] = await db
      .update(organizations)
      .set(body)
      .where(eq(organizations.id, req.params.orgId))
      .returning();
    if (!updated) return reply.notFound();
    return updated;
  });
}
