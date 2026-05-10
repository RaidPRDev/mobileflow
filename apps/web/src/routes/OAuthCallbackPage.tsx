import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";

export function OAuthCallbackPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { refresh } = useAuth();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refresh();
      if (!cancelled) navigate(params.get("git") ? "/" : "/", { replace: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate, params, refresh]);

  return (
    <div className="login-page">
      <div className="empty-state">Finishing sign-in…</div>
    </div>
  );
}
