import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@mobileflow/ui";
import { ApiError, api } from "../api/client";

export function LoginPage() {
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signupMode, setSignupMode] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!showPassword) {
      if (identifier.trim().length === 0) return;
      setShowPassword(true);
      return;
    }
    setSubmitting(true);
    try {
      if (signupMode) {
        const res = await api.signup({ email: identifier.trim(), password });
        navigate(`/org/${res.org.id}/apps`);
      } else {
        await api.login({ email: identifier.trim(), password });
        const me = await api.me();
        const org = me.organizations[0];
        navigate(org ? `/org/${org.orgId}/apps` : "/");
      }
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center p-6 bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">
            {signupMode ? "Create your MobileFlow account" : "Sign in to MobileFlow"}
          </CardTitle>
          <CardDescription>Build, sign and ship mobile apps from your repo.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 mb-4">
            <Button
              variant="outline"
              type="button"
              onClick={() => {
                window.location.href = "/api/auth/oauth/google/start";
              }}
            >
              Continue with Google
            </Button>
            <Button
              variant="outline"
              type="button"
              onClick={() => {
                window.location.href = "/api/auth/oauth/github/start";
              }}
            >
              Continue with GitHub
            </Button>
          </div>
          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">Or</span>
            </div>
          </div>
          <form onSubmit={onSubmit} className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="identifier">Email</Label>
              <Input
                id="identifier"
                type="email"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="you@company.com"
                autoComplete="username"
                required
              />
            </div>
            {showPassword && (
              <div className="grid gap-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={signupMode ? "new-password" : "current-password"}
                  autoFocus
                  required
                  minLength={signupMode ? 8 : undefined}
                />
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="mt-2" loading={submitting}>
              {showPassword ? (signupMode ? "Create account" : "Sign in") : "Continue"}
            </Button>
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-4 hover:underline"
              onClick={() => {
                setSignupMode((s) => !s);
                setError(null);
              }}
            >
              {signupMode ? "Already have an account? Sign in" : "New here? Create an account"}
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
