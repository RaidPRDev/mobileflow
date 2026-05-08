import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@mobileflow/ui";
import { api } from "../api/client";

export function UsagePage() {
  const { orgId } = useParams();
  const subQ = useQuery({ queryKey: ["sub", orgId], queryFn: () => api.getSubscription(orgId!), enabled: !!orgId });
  const plansQ = useQuery({ queryKey: ["billing-plans"], queryFn: () => api.listBillingPlans() });
  const usageQ = useQuery({ queryKey: ["usage", orgId], queryFn: () => api.getUsage(orgId!), enabled: !!orgId, refetchInterval: 5000 });

  const planId = subQ.data?.planId ?? "naboria";
  const plan = plansQ.data?.find((p) => p.id === planId);

  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-semibold">Usage</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{plan?.name ?? planId}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <UsageBar label="Apps" used={usageQ.data?.apps ?? 0} max={plan?.maxApps ?? null} />
          <UsageBar label="Concurrent builds (in flight)" used={usageQ.data?.runningOrQueued ?? 0} max={plan?.maxConcurrentBuilds ?? null} />
          <SeatRow max={plan?.maxSeats ?? null} />
        </CardContent>
      </Card>
    </div>
  );
}

function UsageBar({ label, used, max }: { label: string; used: number; max: number | null }) {
  const limit = max ?? Infinity;
  const ratio = max == null ? 0 : Math.min(1, used / Math.max(1, max));
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between text-sm">
        <span>{label}</span>
        <span className="text-muted-foreground">
          {used} / {max ?? "∞"}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full bg-primary"
          style={{ width: max == null ? "10%" : `${Math.round(ratio * 100)}%` }}
        />
      </div>
      {used >= limit && max != null && <p className="text-xs text-destructive">Limit reached.</p>}
    </div>
  );
}

function SeatRow({ max }: { max: number | null }) {
  return (
    <div className="text-sm flex items-center justify-between border-t pt-3">
      <span>Seats</span>
      <span className="text-muted-foreground">— / {max ?? "∞"}</span>
    </div>
  );
}
