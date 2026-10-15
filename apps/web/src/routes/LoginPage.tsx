import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { APP_MONOGRAM, APP_NAME } from "@mobileflow/shared";
import { Button, Input, Label } from "@mobileflow/ui";
import { ApiError, api } from "../api/client";
import { appBuildLabel } from "../build";
import { ShaderBackground } from "./login/ShaderBackground";
import { ParticleLetter } from "./login/ParticleLetter";
import googleIcon from "../../../../assets/icons/google-icon.svg";
import githubIcon from "../../../../assets/icons/github-icon.svg";

const PASSWORD_RULES = [
  { key: "length", label: "8–128 characters", test: (p: string) => p.length >= 8 && p.length <= 128 },
  { key: "special", label: "1 special character", test: (p: string) => /[^a-zA-Z0-9]/.test(p) },
  { key: "number", label: "1 number", test: (p: string) => /\d/.test(p) },
] as const;

export function LoginPage() {
  const [identifier, setIdentifier] = useState("");
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  // signup steps: 1 = name+username+email, 2 = password+rules, 3 = confirm password
  // login steps: 1 = email, 2 = password
  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signupMode, setSignupMode] = useState(false);

  // OAuth errors come back via `?oauth_error=...` after the provider's
  // callback rejects (e.g. email collision). We surface them inline next to
  // the email field so the user sees the cause without leaving /login.
  const [searchParams] = useSearchParams();
  const oauthError = searchParams.get("oauth_error");
  const oauthErrorEmail = searchParams.get("email");
  const oauthErrorMessage =
    oauthError === "email_taken" && oauthErrorEmail
      ? `${oauthErrorEmail} cannot be processed`
      : oauthError === "email_taken"
        ? "That email cannot be processed"
        : oauthError === "exchange_failed"
          ? "Sign-in failed. Please try again."
          : oauthError
            ? `Sign-in failed (${oauthError})`
            : null;

  const passwordChecks = PASSWORD_RULES.map((r) => ({ ...r, ok: r.test(password) }));
  const passwordValid = passwordChecks.every((c) => c.ok);
  const confirmValid = confirmPassword.length > 0 && confirmPassword === password;

  const resetSteps = () => {
    setStep(1);
    setPassword("");
    setConfirmPassword("");
    setError(null);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (signupMode) {
      if (step === 1) {
        if (fullName.trim().length === 0 || username.trim().length === 0 || identifier.trim().length === 0) return;
        setStep(2);
        return;
      }
      if (step === 2) {
        if (!passwordValid) return;
        setStep(3);
        return;
      }
      if (!confirmValid) {
        setError("Passwords don't match");
        return;
      }
    } else {
      if (step === 1) {
        if (identifier.trim().length === 0) return;
        setStep(2);
        return;
      }
    }

    setSubmitting(true);
    try {
      const email = identifier.trim();
      if (signupMode) {
        // /auth/signup deliberately returns the same {ok: true} body whether
        // the email was new or already registered, and sets no session
        // cookie — that's how the API closes the signup-enumeration channel.
        // We follow up with /auth/login so the new user lands authenticated;
        // a duplicate-email signup will reach this line and fail at login
        // with "Invalid credentials" since the attacker doesn't know the
        // real password.
        await api.signup({
          email,
          password,
          name: fullName.trim(),
          username: username.trim(),
        });
      }
      await api.login({ email, password });
      window.location.replace("/");
      return;
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  const card = (
    <div className="login-card">
        <div className="login-brand">
          <span className="login-brand-mark">{APP_MONOGRAM}</span>
          <span className="section-title">{APP_NAME}</span>
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
            <span className="svc-icon is-google" aria-hidden>
              <img src={googleIcon} alt="" />
            </span>
            Continue with Google
          </Button>
          <Button
            variant="outline"
            type="button"
            onClick={() => {
              window.location.href = "/api/auth/oauth/github/start";
            }}
          >
            <span className="svc-icon is-github" aria-hidden>
              <img src={githubIcon} alt="" />
            </span>
            Continue with GitHub
          </Button>
        </div>
        <div className="login-divider">Or continue with email</div>
        <form onSubmit={onSubmit} className="login-form">
          <div className="login-step" key={`${signupMode ? "signup" : "login"}-${step}`}>
            {signupMode && step === 1 && (
              <>
                <div className="field-group">
                  <Label htmlFor="fullName">Full name</Label>
                  <Input
                    id="fullName"
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Jane Doe"
                    autoComplete="name"
                    autoFocus
                    required
                  />
                </div>
                <div className="field-group">
                  <Label htmlFor="username">Username</Label>
                  <Input
                    id="username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="janedoe"
                    autoComplete="username"
                    required
                  />
                </div>
                <div className="field-group">
                  <Label htmlFor="identifier">Email</Label>
                  <Input
                    id="identifier"
                    type="email"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="you@company.com"
                    autoComplete="email"
                    required
                  />
                </div>
              </>
            )}

            {!signupMode && step === 1 && (
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
            )}

            {signupMode && step === 2 && (
              <>
                <div className="field-group">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    autoFocus
                    required
                  />
                </div>
                <ul className="password-rules">
                  {passwordChecks.map((c) => (
                    <li key={c.key} className={c.ok ? "is-ok" : ""}>
                      <span className="password-rules-check" aria-hidden>
                        {c.ok ? "✓" : ""}
                      </span>
                      {c.label}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {signupMode && step === 3 && (
              <div className="field-group">
                <Label htmlFor="confirmPassword">Confirm password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  autoFocus
                  required
                />
              </div>
            )}

            {!signupMode && step === 2 && (
              <div className="field-group">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  autoFocus
                  required
                />
              </div>
            )}
          </div>

          {error && <p className="text-error">{error}</p>}
          {!error && oauthErrorMessage && (
            <p className="text-error oauth-error">
              <span className="oauth-error-dot" aria-hidden>!</span>
              {oauthErrorMessage}
            </p>
          )}
          <Button
            type="submit"
            loading={submitting}
            className="login-submit-btn"
            disabled={
              (signupMode && step === 2 && !passwordValid) ||
              (signupMode && step === 3 && !confirmValid)
            }
          >
            {signupMode
              ? step === 3
                ? "Create Account →"
                : "Continue"
              : step === 2
                ? "Sign in"
                : "Continue"}
          </Button>
          <button
            type="button"
            className="btn btn-link login-toggle-mode"
            onClick={() => {
              setSignupMode((s) => !s);
              resetSteps();
            }}
          >
            {signupMode ? "Already have an account? Log in" : "New here? Create an account"}
          </button>
        </form>
        <div className="login-build">{appBuildLabel}</div>
    </div>
  );

  return (
    <div className="login-page">
      <ShaderBackground />
      <div className="login-columns">
        <div className="login-hero" aria-hidden>
          <ParticleLetter text="M" />
        </div>
        <div className="login-pane">{card}</div>
      </div>
    </div>
  );
}
