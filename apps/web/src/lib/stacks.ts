import { useQuery } from "@tanstack/react-query";
import { api, type BuildTarget } from "../api/client";

export interface BuildStackOption {
  id: string;
  platform: BuildTarget;
  label: string;
  image: string | null;
  isDefault: boolean;
  sortOrder: number;
}

// The stack catalog used to be a module-level constant. It's now fetched from
// the DB so admins can edit it without redeploying — but the shape of the
// helpers stays caller-friendly (sync once the data is loaded). Callers pass
// the array in and let the helpers do the lookups, which keeps render
// functions out of suspense gymnastics.
export function useStacks() {
  return useQuery({
    queryKey: ["stacks"],
    queryFn: () => api.listStacks(),
    staleTime: 60_000,
  });
}

export function stacksByTarget(
  stacks: BuildStackOption[] | undefined,
  target: BuildTarget,
): BuildStackOption[] {
  if (!stacks) return [];
  return stacks
    .filter((s) => s.platform === target)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

export function stackLabel(
  stacks: BuildStackOption[] | undefined,
  target: BuildTarget,
  id: string | null | undefined,
): string {
  if (!id) return "—";
  const match = stacksByTarget(stacks, target).find((s) => s.id === id);
  return match?.label ?? id;
}
