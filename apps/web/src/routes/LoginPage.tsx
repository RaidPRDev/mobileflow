import { useState } from "react";
import { Button, Input, Label } from "@mobileflow/ui";
import { ApiError, api } from "../api/client";

export function LoginPage() {
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
        await api.signup({ email: identifier.trim(), password });
      } else {
        await api.login({ email: identifier.trim(), password });
      }
      window.location.replace("/");
      return;
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <span className="login-brand-mark">MF</span>
          <span className="section-title">MobileFlow</span>
        </div>
        <div>
          <div className="login-title">
            {signupMode ? "Create your account" : "Welcome back"}
          </div>
          <div className="login-subtitle">Build, sign and ship mobile apps from your repo.</div>
        </div>
        <div className="login-providers">
          <Button
            variant="outline"
            type="button"
            onClick={() => {
              window.location.href = "/api/auth/oauth/google/start";
            }}
          >
            <span className="svc-icon is-google" aria-hidden>G</span>
            Continue with Google
          </Button>
          <Button
            variant="outline"
            type="button"
            onClick={() => {
              window.location.href = "/api/auth/oauth/github/start";
            }}
          >
            <span className="svc-icon is-github" aria-hidden>GH</span>
            Continue with GitHub
          </Button>
        </div>
        <div className="login-divider">Or continue with email</div>
        <form onSubmit={onSubmit} className="login-form">
          <div className="field-group">
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
            <div className="field-group">
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
          {error && <p className="text-error">{error}</p>}
          <Button type="submit" loading={submitting} className="login-submit-btn">
            {showPassword ? (signupMode ? "Create account" : "Sign in") : "Continue"}
          </Button>
          <button
            type="button"
            className="btn btn-link login-toggle-mode"
            onClick={() => {
              setSignupMode((s) => !s);
              setError(null);
            }}
          >
            {signupMode ? "Already have an account? Sign in" : "New here? Create an account"}
          </button>
        </form>
      </div>
    </div>
  );
}
