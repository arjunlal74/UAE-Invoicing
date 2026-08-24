import { isPasswordAcceptable } from '@uae/contracts';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { NewPasswordFields } from '../components/PasswordFields';
import { Alert, Button, Field, inputClass } from '../components/ui';
import { ApiError, api } from '../lib/api';

/**
 * Invitation acceptance.
 *
 * Unauthenticated by design — the token in the URL is the credential. The user
 * sets their own name and password here; the account exists but has no password
 * hash until this completes.
 */
export function AcceptInvitePage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    if (!isPasswordAcceptable(password)) {
      setError('Your password does not meet the requirements listed below.');
      return;
    }

    setBusy(true);
    try {
      await api('/api/v1/auth/accept-invite', {
        method: 'POST',
        body: { token, fullName, password },
      });
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'This invitation could not be completed.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-800 px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-center text-lg font-semibold text-white">
          UAE E-Invoicing
        </h1>

        <div className="rounded-lg bg-white p-6 shadow-lg">
          {!token ? (
            <Alert kind="danger">
              This link is missing its invitation token. Ask your administrator to send it again.
            </Alert>
          ) : done ? (
            <div className="space-y-4 text-center">
              <Alert kind="ok">Your account is ready.</Alert>
              <Link to="/login">
                <Button variant="primary" className="w-full justify-center">
                  Sign in
                </Button>
              </Link>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <p className="text-sm text-slate-600">
                Set your name and a password to activate your account.
              </p>

              {error && <Alert kind="danger">{error}</Alert>}

              <Field label="Full name" required>
                <input
                  className={inputClass}
                  value={fullName}
                  required
                  autoFocus
                  onChange={(e) => setFullName(e.target.value)}
                />
              </Field>

              <NewPasswordFields
                password={password}
                confirmation={confirm}
                onPasswordChange={setPassword}
                onConfirmationChange={setConfirm}
                label="Password"
              />

              <Button
                type="submit"
                variant="primary"
                disabled={busy}
                className="w-full justify-center"
              >
                {busy ? 'Creating…' : 'Create account'}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
