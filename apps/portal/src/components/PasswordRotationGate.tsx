import type { LoginResponse } from '@uae/contracts';
import { useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useAuthStore } from '../stores/auth';
import { NewPasswordFields, newPasswordReady } from './PasswordFields';
import { Alert, Button, Field, inputClass } from './ui';

/**
 * Forced rotation — SRS v2.3 §4.3.
 *
 * "The application restricts access to an isolated modal forcing the user to
 * establish a permanent secret before any tax data can be accessed." Rendered
 * in place of the application rather than over it: an overlay can be dismissed
 * with developer tools, and the screen behind it would have already fetched the
 * data the gate exists to withhold.
 *
 * The API refuses every other route for this session regardless, so this is the
 * usable face of a control enforced on the server, not the control itself.
 */
export function PasswordRotationGate() {
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const setSession = useAuthStore((s) => s.setSession);
  const clear = useAuthStore((s) => s.clear);

  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await api('/api/v1/auth/change-password', {
        method: 'POST',
        body: {
          currentPassword,
          newPassword: password,
          signOutOtherDevices: true,
          // Hand over this session's own token so ending the others does not
          // end this one and drop the user back at sign-in.
          currentRefreshToken: refreshToken ?? undefined,
        },
      });

      // The access token still asserts the rotation flag; only a fresh one
      // clears the gate, so the session is exchanged before continuing.
      const session = await api<LoginResponse>('/api/v1/auth/refresh', {
        method: 'POST',
        body: { refreshToken },
      });
      setSession(session);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your password could not be changed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white shadow-sm">
        <header className="border-b border-slate-200 px-4 py-3">
          <h1 className="text-sm font-semibold text-slate-800">Set a new password to continue</h1>
        </header>

        <form onSubmit={submit} className="space-y-4 p-4">
          <Alert kind="warn" title="A password change is required">
            An administrator has asked you to choose a new password. You cannot reach any invoice
            or tax data until you do.
          </Alert>

          {error && <Alert kind="danger">{error}</Alert>}

          <Field label="Current password" required>
            <input
              className={inputClass}
              type="password"
              autoComplete="current-password"
              autoFocus
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </Field>

          <NewPasswordFields
            password={password}
            confirmation={confirmation}
            onPasswordChange={setPassword}
            onConfirmationChange={setConfirmation}
          />

          <div className="flex items-center justify-between border-t border-slate-200 pt-3">
            <button
              type="button"
              onClick={clear}
              className="text-sm text-slate-500 underline hover:text-slate-700"
            >
              Sign out instead
            </button>
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !currentPassword || !newPasswordReady(password, confirmation)}
            >
              {busy ? 'Saving…' : 'Set password and continue'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
