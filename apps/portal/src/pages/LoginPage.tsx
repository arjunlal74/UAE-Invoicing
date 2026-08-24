import type { LoginResponse } from '@uae/contracts';
import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Alert, Button, Field, inputClass } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { homePathFor, useAuthStore } from '../stores/auth';

export function LoginPage() {
  const { user, accessToken, setSession } = useAuthStore();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (accessToken && user) {
    return <Navigate to={homePathFor(user)} replace />;
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const result = await api<LoginResponse | { mfaRequired: true }>('/api/v1/auth/login', {
        method: 'POST',
        body: { email, password, mfaCode: mfaCode || undefined },
      });

      // The server answers "MFA required" rather than failing, so the password
      // is verified exactly once and the second factor is a separate step.
      if ('mfaRequired' in result) {
        setMfaRequired(true);
        setBusy(false);
        return;
      }

      setSession(result);
      navigate(homePathFor(result.user), { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not sign in. Please try again.',
      );
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-800 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mb-2 inline-flex items-center gap-2">
            <span className="rounded bg-white/15 px-2 py-1 text-sm font-bold tracking-wide text-white">
              UAE
            </span>
            <span className="text-lg font-semibold text-white">E-Invoicing</span>
          </div>
          <p className="text-sm text-white/70">Federal Tax Authority compliant invoicing</p>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-lg bg-white p-6 shadow-lg">
          {error && <Alert kind="danger">{error}</Alert>}

          {!mfaRequired ? (
            <>
              <Field label="Email address" required>
                <input
                  className={inputClass}
                  type="email"
                  value={email}
                  autoComplete="username"
                  autoFocus
                  required
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>

              <Field label="Password" required>
                <input
                  className={inputClass}
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  required
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            </>
          ) : (
            <>
              <Alert kind="info">
                Enter the six-digit code from your authenticator app.
              </Alert>
              <Field label="Authentication code" required>
                <input
                  className={`${inputClass} text-center font-mono text-lg tracking-[0.4em]`}
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  value={mfaCode}
                  autoFocus
                  required
                  onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
                />
              </Field>
            </>
          )}

          <Button type="submit" variant="primary" disabled={busy} className="w-full justify-center">
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>

          {/* §4.4 makes password reset the immediate way out of a lockout, so
              this stays visible rather than hiding behind a failed attempt. */}
          <p className="text-center text-sm">
            <Link to="/forgot-password" className="text-brand-600 underline">
              Forgot your password?
            </Link>
          </p>
        </form>

        <p className="mt-4 text-center text-xs text-white/50">
          Data is processed and stored within the United Arab Emirates.
        </p>
      </div>
    </div>
  );
}
