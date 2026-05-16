import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Combobox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
} from "@mobileflow/ui";
import { CheckCircle2, XCircle } from "lucide-react";
import { RUNTIME_LABEL } from "@mobileflow/shared";
import { ApiError, api } from "../api/client";
import { formatFullDate, relativeTime } from "../lib/dates";

const PLAN_OPTIONS = [
  { value: "naboria", label: "Naboria" },
  { value: "bohio", label: "Bohio" },
  { value: "yucayeque", label: "Yucayeque" },
  { value: "cacique", label: "Cacique" },
  { value: "unlimited", label: "Unlimited" },
];

type BuildTarget = "ios" | "android" | "web";
type BuildStatus = "queued" | "running" | "success" | "failed" | "cancelled";

const PLATFORM_META: Record<BuildTarget, { label: string; iconBg: string; icon: JSX.Element }> = {
  ios: { label: "iOS", iconBg: "#0a0a0a", icon: <AppleIcon /> },
  android: { label: "Android", iconBg: "#34a853", icon: <AndroidIcon /> },
  web: { label: "Web", iconBg: "#f7df1e", icon: <WebIcon /> },
};

const STATUS_TOOLTIP: Record<BuildStatus, string> = {
  queued: "Queued",
  running: "Running",
  success: "Build successful",
  failed: "Build failed",
  cancelled: "Build cancelled",
};

export function AdminOrgDetailPage() {
  const { orgId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["admin", "org", orgId],
    queryFn: () => api.admin.org(orgId!),
    enabled: !!orgId,
  });

  const setPlan = useMutation({
    mutationFn: (planId: string) => api.admin.setOrgPlan(orgId!, planId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "org", orgId] }),
  });

  const remove = useMutation({
    mutationFn: () => api.admin.deleteOrg(orgId!),
    onSuccess: () => navigate("/admin/orgs"),
  });

  const appNameById = useMemo(() => {
    const map = new Map<string, string>();
    q.data?.apps.forEach((a) => map.set(a.id, a.name));
    return map;
  }, [q.data?.apps]);

  if (q.isLoading) {
    return (
      <div className="page">
        <p className="builds-status">Loading…</p>
      </div>
    );
  }
  if (q.error) {
    return (
      <div className="page">
        <p className="builds-status is-error">{(q.error as ApiError).message}</p>
      </div>
    );
  }
  const data = q.data!;

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__main">
          <h1 className="page-title">{data.org.name}</h1>
        </div>
        <Button
          variant="destructive"
          onClick={() => {
            if (confirm(`Delete organization "${data.org.name}"? This cascades to apps + builds.`)) remove.mutate();
          }}
        >
          Delete organization
        </Button>
      </header>
      <p className="page-subtitle font-mono">{data.org.id}</p>

      <Card className="admin-section-card">
        <CardHeader>
          <CardTitle className="text-base">Plan</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="admin-section-card__body">
            <Combobox
              value={data.subscription?.planId ?? undefined}
              onChange={(v) => setPlan.mutate(v)}
              options={PLAN_OPTIONS}
              placeholder="Select a plan…"
              disabled={setPlan.isPending}
              ariaLabel="Plan"
            />
          </div>
        </CardContent>
      </Card>

      <Card className="admin-section-card">
        <CardHeader>
          <CardTitle className="text-base">Members ({data.members.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {data.members.length === 0 ? (
            <p className="admin-section-card__body empty-state__body">No members.</p>
          ) : (
            <ul className="apps-list">
              {data.members.map((m) => (
                <MemberListItem key={m.userId} member={m} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="admin-section-card">
        <CardHeader>
          <CardTitle className="text-base">Apps ({data.apps.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {data.apps.length === 0 ? (
            <p className="admin-section-card__body empty-state__body">No apps.</p>
          ) : (
            <ul className="apps-list">
              {data.apps.map((a) => (
                <OrgAppListItem key={a.id} app={a} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="admin-section-card">
        <CardHeader>
          <CardTitle className="text-base">Recent builds</CardTitle>
        </CardHeader>
        <CardContent>
          {data.recentBuilds.length === 0 ? (
            <p className="admin-section-card__body empty-state__body">No builds.</p>
          ) : (
            <div className="data-grid admin-builds-table" role="table">
              <div className="data-grid__head" role="row">
                <span role="columnheader">Build</span>
                <span role="columnheader">Status</span>
                <span role="columnheader">Platform</span>
                <span role="columnheader">App</span>
                <span role="columnheader">Commit</span>
                <span role="columnheader" aria-label="Actions"></span>
              </div>
              {data.recentBuilds.map((b) => (
                <OrgBuildRow
                  key={b.id}
                  build={b}
                  appName={appNameById.get(b.appId) ?? b.appId.slice(0, 8)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface OrgMember {
  userId: string;
  email: string;
  name: string | null;
  role: "owner" | "admin" | "member";
  isSuperadmin: boolean;
}

function MemberListItem({ member }: { member: OrgMember }) {
  const displayName = member.name?.trim() || member.email;
  const { hue, letter } = avatarSeed(member.userId || member.email, displayName);
  const style = {
    background: `linear-gradient(135deg, hsl(${hue}, 70%, 78%) 0%, hsl(${(hue + 30) % 360}, 65%, 60%) 100%)`,
  };
  return (
    <li className="apps-list__item">
      <div className="apps-list__link" style={{ cursor: "default" }}>
        <div className="apps-list__icon" style={style} aria-hidden="true">
          <span className="apps-list__icon-letter">{letter}</span>
        </div>
        <div className="apps-list__meta">
          <div className="apps-list__name">{displayName}</div>
          <div className="apps-list__sub">
            {member.name && <span>{member.email}</span>}
            {member.name && <span className="apps-list__dot">·</span>}
            <span>{member.role}</span>
            {member.isSuperadmin && (
              <>
                <span className="apps-list__dot">·</span>
                <span className="apps-list__badge apps-list__badge--warn">superadmin</span>
              </>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

interface OrgApp {
  id: string;
  name: string;
  runtime: string;
  gitRepoFullName: string | null;
  createdAt: string;
}

function OrgAppListItem({ app }: { app: OrgApp }) {
  const navigate = useNavigate();
  const runtime = RUNTIME_LABEL[app.runtime as keyof typeof RUNTIME_LABEL] ?? app.runtime;
  const shortId = app.id.slice(0, 8);
  const created = relativeTime(app.createdAt);
  const createdFull = formatFullDate(app.createdAt);
  const { hue, letter } = avatarSeed(app.id, app.name);
  const style = {
    background: `linear-gradient(135deg, hsl(${hue}, 70%, 78%) 0%, hsl(${(hue + 30) % 360}, 65%, 60%) 100%)`,
  };

  return (
    <li className="apps-list__item">
      <button
        type="button"
        className="apps-list__link"
        onClick={() => navigate(`/app/${app.id}/commits`)}
        style={{ background: "transparent", border: 0, textAlign: "left", font: "inherit", cursor: "pointer" }}
      >
        <div className="apps-list__icon" style={style} aria-hidden="true">
          <span className="apps-list__icon-letter">{letter}</span>
        </div>
        <div className="apps-list__meta">
          <div className="apps-list__name">{app.name}</div>
          <div className="apps-list__sub">
            <span>{runtime}</span>
            <span className="apps-list__dot">·</span>
            <span className="apps-list__id">{shortId}</span>
            <span className="apps-list__dot">·</span>
            {!app.gitRepoFullName && (
              <>
                <span className="apps-list__badge apps-list__badge--warn">No repo connected</span>
                <span className="apps-list__dot">·</span>
              </>
            )}
            <span
              className="tooltip-wrap"
              tabIndex={0}
              onClick={(e) => e.preventDefault()}
            >
              Created {created}
              <span className="tooltip-bubble" role="tooltip">{createdFull}</span>
            </span>
          </div>
        </div>
      </button>
    </li>
  );
}

interface OrgBuild {
  id: string;
  status: string;
  target: string;
  createdAt: string;
  commitSha: string;
  appId: string;
}

function OrgBuildRow({ build, appName }: { build: OrgBuild; appName: string }) {
  const navigate = useNavigate();
  const target = (build.target as BuildTarget) in PLATFORM_META ? (build.target as BuildTarget) : "web";
  const status = build.status as BuildStatus;
  const platform = PLATFORM_META[target];
  const commitShort = build.commitSha.slice(0, 6);
  const fullDate = formatFullDate(build.createdAt);
  const appInitial = (appName || "?").trim().charAt(0).toUpperCase();
  const goToBuild = () => navigate(`/app/${build.appId}/build/builds/${build.id}`);

  return (
    <div
      className="data-grid__row builds-row is-clickable"
      role="row"
      onClick={goToBuild}
    >
      <div role="cell" className="builds-row__build-cell">
        <button
          type="button"
          className="builds-row__build"
          onClick={(e) => {
            e.stopPropagation();
            goToBuild();
          }}
        >
          #{build.id.slice(0, 6)}
        </button>
      </div>
      <div role="cell" className="builds-row__status">
        {status === "success" ? (
          <span className="tooltip-wrap" tabIndex={0}>
            <CheckCircle2 size={18} className="status-icon is-success" aria-hidden />
            <span className="tooltip-bubble" role="tooltip">{STATUS_TOOLTIP.success}</span>
          </span>
        ) : status === "failed" ? (
          <span className="tooltip-wrap" tabIndex={0}>
            <XCircle size={18} className="status-icon is-failed" aria-hidden />
            <span className="tooltip-bubble" role="tooltip">{STATUS_TOOLTIP.failed}</span>
          </span>
        ) : (
          <span className={`status-pill is-${status}`}>{status}</span>
        )}
      </div>
      <div role="cell" className="builds-row__platform">
        <span className="builds-row__platform-icon" style={{ background: platform.iconBg }}>
          {platform.icon}
        </span>
        <span className="builds-row__platform-label">{platform.label}</span>
      </div>
      <div role="cell" className="builds-row__triggered">
        <span className="builds-row__triggered-avatar">
          <span className="commit-row__avatar-fallback">{appInitial}</span>
        </span>
        <div className="builds-row__triggered-meta">
          <span className="builds-row__triggered-name">{appName}</span>
          <span className="builds-row__triggered-date">{build.appId.slice(0, 8)}</span>
        </div>
      </div>
      <div role="cell" className="builds-row__commit">
        <span className="builds-row__commit-avatar">
          <span className="commit-row__avatar-fallback">C</span>
        </span>
        <div className="builds-row__commit-meta">
          <div className="builds-row__commit-line">
            <span className="builds-row__commit-sha">{commitShort}</span>
          </div>
          <div className="builds-row__commit-sub">
            <span className="tooltip-wrap" tabIndex={0} aria-label={fullDate}>
              {relativeTime(build.createdAt)}
              <span className="tooltip-bubble" role="tooltip">{fullDate}</span>
            </span>
          </div>
        </div>
      </div>
      <div role="cell" className="builds-row__menu" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton variant="menu" aria-label="Build actions" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={goToBuild}>View build</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate(`/app/${build.appId}/commits`)}>
              View app
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function avatarSeed(seed: string, fallbackLetter: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return {
    hue: h % 360,
    letter: (fallbackLetter.trim()[0] ?? "?").toUpperCase(),
  };
}

function AppleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff" xmlns="http://www.w3.org/2000/svg">
      <path d="M19.665 16.811a10.316 10.316 0 0 1-1.021 1.837c-.537.767-.978 1.297-1.316 1.592-.525.482-1.089.73-1.692.744-.432 0-.954-.123-1.562-.373-.61-.249-1.17-.371-1.683-.371-.537 0-1.113.122-1.73.371-.616.25-1.114.381-1.495.393-.577.025-1.154-.229-1.729-.764-.367-.318-.83-.866-1.388-1.645-.598-.83-1.087-1.79-1.467-2.876-.413-1.17-.62-2.305-.62-3.402 0-1.257.272-2.34.815-3.249.428-.728 1-1.301 1.715-1.72.713-.42 1.485-.633 2.314-.647.46 0 1.063.142 1.81.422.745.28 1.225.422 1.435.422.158 0 .69-.165 1.594-.493.857-.305 1.58-.43 2.17-.382 1.605.13 2.81.764 3.612 1.905-1.434.873-2.144 2.094-2.13 3.66.013 1.222.451 2.238 1.314 3.046.39.371.825.658 1.31.864-.105.305-.215.598-.331.879zm-3.873-15.43c0 .938-.342 1.815-1.027 2.628-.825.964-1.823 1.522-2.906 1.434a2.93 2.93 0 0 1-.022-.354c0-.9.392-1.864 1.087-2.654.347-.4.787-.733 1.32-1 .533-.262 1.037-.408 1.512-.434.014.13.036.26.036.38z" />
    </svg>
  );
}

function AndroidIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.523 15.341a1.04 1.04 0 1 1 0-2.082 1.04 1.04 0 0 1 0 2.082m-11.046 0a1.04 1.04 0 1 1 0-2.082 1.04 1.04 0 0 1 0 2.082m11.42-6.02 2.078-3.6a.43.43 0 1 0-.745-.43l-2.103 3.643a13.05 13.05 0 0 0-5.127-1.04c-1.842 0-3.59.378-5.127 1.04L4.77 5.291a.43.43 0 1 0-.745.43l2.078 3.6C2.554 11.218 0 14.696 0 18.708h24c0-4.012-2.554-7.49-6.103-9.387" />
    </svg>
  );
}

function WebIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <text x="12" y="17" textAnchor="middle" fontSize="10" fontFamily="Arial, sans-serif" fontWeight="700" fill="#0a0a0a">JS</text>
    </svg>
  );
}
