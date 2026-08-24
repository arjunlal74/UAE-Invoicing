import type { ResetTokenCheckResponse } from '@uae/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { NewPasswordFields, newPasswordReady } from '../components/PasswordFields';
import { Alert, Button, Card, Spinner } from '../components/ui';
import { ApiError, api } from '../lib/api';

/**
 * Redeem a reset link — SRS v2.3 §4.1 steps 6 and 7.
 *
 * The link is checked before the form is shown. Asking someone to compose and
 * confirm a password only to be told the link expired twenty hours ago is a
 * cruelty the extra request avoids.
 */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const check = useQuery({
    queryKey: ['reset-token', token],
    queryFn: () =>
      api<ResetTokenCheckResponse>(`/api/v1/auth/reset-password?token=${encodeURIComponent(token)}`),
    retry: false,
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await api('/api/v1/auth/reset-password', { method: 'POST', body: { token, password } });
      setDone(true);
      // A moment on the confirmation, then to sign-in. Every session was
      // revoked server-side, so there is nothing to return to.
      setTimeout(() => navigate('/login', { replace: true }), 2500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your password could not be changed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md">
        <Card title="Choose a new password">
          {check.isLoading ? (
            <Spinner label="Checking your link…" />
          ) : done ? (
            <div className="space-y-3">
              <Alert kind="ok" title="Your password has been changed">
                All other sessions have been signed out. Taking you to the sign-in page…
              </Alert>
              <Link to="/login" className="text-sm text-brand-600 underline">
                Sign in now
              </Link>
            </div>
          ) : !check.data?.valid ? (
            <div className="space-y-3">
              <Alert kind="danger" title="This link cannot be used">
                {check.data?.message ?? 'This link is not valid.'}
              </Alert>
              <Link to="/forgot-password" className="text-sm text-brand-600 underline">
                Request a new link
              </Link>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <p className="text-sm text-slate-600">
                Setting a new password for <strong>{check.data.email}</strong>.
              </p>

              {error && <Alert kind="danger">{error}</Alert>}

              <NewPasswordFields
                password={password}
                confirmation={confirmation}
                onPasswordChange={setPassword}
                onConfirmationChange={setConfirmation}
                autoFocus
              />

              <p className="text-xs text-slate-500">
                Signing in everywhere else will end when you save: all active sessions are revoked.
              </p>

              <div className="flex justify-end">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={busy || !newPasswordReady(password, confirmation)}
                >
                  {busy ? 'Saving…' : 'Set new password'}
                </Button>
              </div>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
