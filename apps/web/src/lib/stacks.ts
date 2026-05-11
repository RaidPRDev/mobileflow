import type { BuildTarget } from "../api/client";

export interface BuildStackOption {
  id: string;
  label: string;
}

export const STACKS: Record<BuildTarget, BuildStackOption[]> = {
  ios: [
    { id: "ios-15", label: "Xcode 15" },
    { id: "ios-16", label: "Xcode 16" },
  ],
  android: [{ id: "android-default", label: "Android (default)" }],
  web: [{ id: "web-default", label: "Web (Node 20)" }],
};

export function getStackLabel(target: BuildTarget, id: string | null | undefined): string {
  if (!id) return "—";
  return STACKS[target]?.find((s) => s.id === id)?.label ?? id;
}
