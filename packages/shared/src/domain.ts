import { z } from "zod";

export const RuntimeSchema = z.enum([
  "capacitor",
  "cordova",
  "react_native",
  "ios_native",
  "android_native",
]);
export type Runtime = z.infer<typeof RuntimeSchema>;

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
