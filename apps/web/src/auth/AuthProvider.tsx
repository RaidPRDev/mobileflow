import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ApiError, api, type MeResponse } from "../api/client";

type Status = "loading" | "authenticated" | "anonymous";

interface AuthContextValue {
  status: Status;
  me: MeResponse | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<MeResponse | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.me();
      setMe(data);
      setStatus("authenticated");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setMe(null);
        setStatus("anonymous");
      } else {
        // network/other — treat as anonymous so the app boots; show a banner later
        setMe(null);
        setStatus("anonymous");
      }
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setMe(null);
      setStatus("anonymous");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AuthContextValue>(() => ({ status, me, refresh, signOut }), [status, me, refresh, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>");
  return v;
}
