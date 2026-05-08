import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@mobileflow/ui";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";

export function AdminUsersPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "users"], queryFn: () => api.admin.users() });

  const setUser = useMutation({
    mutationFn: ({ id, isSuperadmin }: { id: string; isSuperadmin: boolean }) =>
      api.admin.setUser(id, { isSuperadmin }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
  const forceLogout = useMutation({
    mutationFn: (id: string) => api.admin.forceLogout(id),
  });
  const deleteUser = useMutation({
    mutationFn: (id: string) => api.admin.deleteUser(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });

  return (
    <div className="grid gap-4 max-w-5xl">
      <h1 className="text-2xl font-semibold">Users</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{q.data?.length ?? "—"} users</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {q.data?.map((u) => {
            const self = u.id === me?.user.id;
            return (
              <div key={u.id} className="flex items-center justify-between gap-3 border-b last:border-0 py-2">
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">
                    {u.email}
                    {u.isSuperadmin && (
                      <span className="ml-2 text-xs uppercase rounded-full px-1.5 py-0.5 bg-primary/15 text-primary">superadmin</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {u.memberships.map((m) => `${m.orgName} (${m.role})`).join(", ") || "no memberships"}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setUser.mutate({ id: u.id, isSuperadmin: !u.isSuperadmin })}
                    disabled={self}
                    title={self ? "Cannot change yourself" : undefined}
                  >
                    {u.isSuperadmin ? "Demote" : "Make superadmin"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => forceLogout.mutate(u.id)}>
                    Force logout
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (confirm(`Delete ${u.email}? This cascades to their owned orgs.`)) deleteUser.mutate(u.id);
                    }}
                    disabled={self}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
