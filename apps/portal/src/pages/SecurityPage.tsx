import { useState } from 'react';
import { NewPasswordFields, newPasswordReady } from '../components/PasswordFields';
import { Alert, Button, Card, Field, inputClass } from '../components/ui';
import { ApiError, api } from '../lib/api';
import { useAuthStore } from '../stores/auth';

/**
 * Authenticated in-session password change — SRS v2.3 §4.2.
 *
 * Available to every signed-in role rather than living under merchant settings:
 * a platform administrator has the most privileged credential on the system and
 * is the last person who should have to ask someone else to rotate it.
 */
export function SecurityPage() {
  const user = useAuthStore((s) => s.user);
  const refreshToken = useAuthStore((s) => s.refreshToken);

  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setResult(null);

    try {
      await api('/api/v1/auth/change-password', {
        method: 'POST',
        body: {
          currentPassword,
          newPassword: password,
          signOutOtherDevices: signOutOthers,
          // Kept alive so choosing "sign out everywhere else" does not sign
          // this browser out as well.
          currentRefreshToken: refreshToken ?? undefined,
        },
      });

      setResult({
        ok: true,
        text: signOutOthers
          ? 'Your password has been changed and all other sessions were signed out.'
          : 'Your password has been changed.',
      });
      setCurrentPassword('');
      setPassword('');
      setConfirmation('');
    } catch (err) {
      setResult({
        ok: false,
        text: err instanceof ApiError ? err.message : 'Your password could not be changed.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-lg font-semibold text-slate-900">Security</h1>

      <Card title="Change your password">
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-slate-600">
            Signed in as <strong>{user?.email}</strong>.
          </p>

          {result && <Alert kind={result.ok ? 'ok' : 'danger'}>{result.text}</Alert>}

          <Field label="Current password" required>
            <input
              className={inputClass}
              type="password"
              autoComplete="current-password"
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

          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={signOutOthers}
              onChange={(e) => setSignOutOthers(e.target.checked)}
            />
            <span>
              Sign out of all other active devices and browsers
              <span className="mt-0.5 block text-xs text-slate-500">
                Recommended if you are changing your password because you think someone else may
                know it.
              </span>
            </span>
          </label>

          <p className="text-xs text-slate-500">
            You cannot reuse any of your last three passwords.
          </p>

          <div className="flex justify-end border-t border-slate-200 pt-3">
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !currentPassword || !newPasswordReady(password, confirmation)}
            >
              {busy ? 'Saving…' : 'Change password'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
