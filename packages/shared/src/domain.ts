import { z } from "zod";
import { RUNTIME_IDS } from "./runtimes";

export const RuntimeSchema = z.enum(RUNTIME_IDS);

export const GitProviderSchema = z.enum(["github", "gitlab", "bitbucket"]);
export type GitProvider = z.infer<typeof GitProviderSchema>;

export const PlanIdSchema = z.enum(["naboria", "bohio", "yucayeque", "cacique", "unlimited"]);
export type PlanId = z.infer<typeof PlanIdSchema>;

export const BuildTargetSchema = z.enum(["ios", "android", "web"]);
export type BuildTarget = z.infer<typeof BuildTargetSchema>;

export const BuildStatusSchema = z.enum([
  "queued",
  "running",
  "success",
  "failed",
  "cancelled",
]);
export type BuildStatus = z.infer<typeof BuildStatusSchema>;

export const OrgMemberRoleSchema = z.enum(["owner", "admin", "member"]);
export type OrgMemberRole = z.infer<typeof OrgMemberRoleSchema>;
