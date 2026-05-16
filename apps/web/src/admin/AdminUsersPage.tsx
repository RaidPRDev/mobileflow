import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
} from "@mobileflow/ui";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { formatFullDate, relativeTime } from "../lib/dates";

interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  isSuperadmin: boolean;
  createdAt: string;
  memberships: { orgId: string; orgName: string; role: "owner" | "admin" | "member" }[];
}

export function AdminUsersPage() {
  const q = useQuery({ queryKey: ["admin", "users"], queryFn: () => api.admin.users() });

  const users = q.data ?? [];

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">Users</h1>
      </header>

      {q.isLoading && <div className="builds-status">Loading users…</div>}
      {q.error && (
        <div className="builds-status is-error">{(q.error as Error).message}</div>
      )}

      {!q.isLoading && users.length === 0 && (
        <div className="empty-state">
          <h2 className="empty-state__title">No users</h2>
        </div>
      )}

      {!!users.length && (
        <div className="data-grid admin-users-table" role="table">
          <div className="data-grid__head" role="row">
            <span role="columnheader">User</span>
            <span role="columnheader">Role</span>
            <span role="columnheader">Memberships</span>
            <span role="columnheader">Joined</span>
            <span role="columnheader" aria-label="Actions"></span>
          </div>
          {users.map((u) => (
            <UserRow key={u.id} user={u} />
          ))}
        </div>
      )}
    </div>
  );
}

function UserRow({ user }: { user: AdminUser }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const self = user.id === me?.user.id;

  const setUser = useMutation({
    mutationFn: (isSuperadmin: boolean) => api.admin.setUser(user.id, { isSuperadmin }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
  const forceLogout = useMutation({
    mutationFn: () => api.admin.forceLogout(user.id),
  });
  const deleteUser = useMutation({
    mutationFn: () => api.admin.deleteUser(user.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });

  const displayName = user.name?.trim() || user.email;
  const fullDate = formatFullDate(user.createdAt);
  const membershipSummary =
    user.memberships.length === 0
      ? "—"
      : user.memberships
          .slice(0, 2)
          .map((m) => `${m.orgName} (${m.role})`)
          .join(", ") + (user.memberships.length > 2 ? ` +${user.memberships.length - 2}` : "");

  return (
    <div className="data-grid__row builds-row" role="row">
      <div role="cell" className="builds-row__triggered">
        <UserAvatar user={user} />
        <div className="builds-row__triggered-meta">
          <span className="builds-row__triggered-name">{displayName}</span>
          {user.name && (
            <span className="builds-row__triggered-date">{user.email}</span>
          )}
        </div>
      </div>
      <div role="cell">
        {user.isSuperadmin ? (
          <span className="apps-list__badge apps-list__badge--warn">superadmin</span>
        ) : (
          <span className="builds-row__platform-label">user</span>
        )}
      </div>
      <div role="cell" className="admin-users-row__memberships">
        {membershipSummary}
      </div>
      <div role="cell" className="builds-row__commit-sub">
        <span className="tooltip-wrap" tabIndex={0} aria-label={fullDate}>
          {relativeTime(user.createdAt)}
          <span className="tooltip-bubble" role="tooltip">{fullDate}</span>
        </span>
      </div>
      <div role="cell" className="builds-row__menu">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton variant="menu" aria-label={`Actions for ${displayName}`} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={self}
              onSelect={() => setUser.mutate(!user.isSuperadmin)}
            >
              {user.isSuperadmin ? "Demote" : "Make superadmin"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => forceLogout.mutate()}>
              Force logout
            </DropdownMenuItem>
            <DropdownMenuItem
              destructive
              disabled={self}
              onSelect={() => {
                if (confirm(`Delete ${user.email}? This cascades to their owned orgs.`)) deleteUser.mutate();
              }}
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function UserAvatar({ user }: { user: AdminUser }) {
  if (user.avatarUrl) {
    return (
      <span className="builds-row__commit-avatar">
        <img src={user.avatarUrl} alt="" />
      </span>
    );
  }
  const seed = user.id || user.email;
  const letter = (user.name?.trim()[0] ?? user.email.trim()[0] ?? "?").toUpperCase();
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const style = {
    background: `linear-gradient(135deg, hsl(${hue}, 70%, 78%) 0%, hsl(${(hue + 30) % 360}, 65%, 60%) 100%)`,
  };
  return (
    <span className="builds-row__commit-avatar" style={style} aria-hidden="true">
      <span className="apps-list__icon-letter">{letter}</span>
    </span>
  );
}
