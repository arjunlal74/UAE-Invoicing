import type { ForgotPasswordResponse } from '@uae/contracts';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, Field, inputClass } from '../components/ui';
import { ApiError, api } from '../lib/api';

/**
 * Self-service recovery request — SRS v2.3 §4.1.
 *
 * The screen deliberately cannot tell the user whether their address is
 * registered. The confirmation is rendered from the server's own wording and is
 * identical whether the account exists, is deactivated, or the caller has hit
 * the hourly cap. Anything friendlier here would hand an attacker a way to
 * enumerate the customer base.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await api<ForgotPasswordResponse>('/api/v1/auth/forgot-password', {
        method: 'POST',
        body: { email },
      });
      setSent(result.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That request could not be completed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md">
        <Card title="Reset your password">
          {sent ? (
            <div className="space-y-4">
              <Alert kind="ok" title="Check your inbox">
                {sent}
              </Alert>
              <p className="text-sm text-slate-600">
                The link is valid for 24 hours and can only be used once. If nothing arrives, check
                your spam folder before requesting another — there is a limit of three requests an
                hour.
              </p>
              <Link to="/login" className="text-sm text-brand-600 underline">
                Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <p className="text-sm text-slate-600">
                Enter the email address for your account and we will send you a link to set a new
                password.
              </p>

              {error && <Alert kind="danger">{error}</Alert>}

              <Field label="Email address" required>
                <input
                  className={inputClass}
                  type="email"
                  autoComplete="username"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>

              <div className="flex items-center justify-between">
                <Link to="/login" className="text-sm text-brand-600 underline">
                  Back to sign in
                </Link>
                <Button type="submit" variant="primary" disabled={busy || !email}>
                  {busy ? 'Sending…' : 'Send reset link'}
                </Button>
              </div>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
