import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@mobileflow/ui";
import { api } from "../api/client";

export function AdminOverviewPage() {
  const q = useQuery({ queryKey: ["admin", "stats"], queryFn: () => api.admin.stats(), refetchInterval: 4000 });

  return (
    <div className="grid gap-4 max-w-4xl">
      <h1 className="text-2xl font-semibold">Overview</h1>
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Users" value={q.data?.users} />
        <Stat label="Organizations" value={q.data?.organizations} />
        <Stat label="Apps" value={q.data?.apps} />
        <Stat label="Builds (total)" value={q.data?.builds} />
        <Stat label="Running / queued" value={q.data?.runningOrQueued} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold">{value ?? "—"}</div>
      </CardContent>
    </Card>
  );
}
