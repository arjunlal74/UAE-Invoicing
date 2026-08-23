import {
  MAIL_ENCRYPTION_LABELS,
  type MailAccountSummary,
  type MailAutodiscoverResult,
  type MailEncryption,
} from '@uae/contracts';
import { useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { Alert, Button, Field, Spinner, inputClass } from '../../components/ui';

/**
 * Add-account wizard.
 *
 * Modelled on the mail-client flow everyone already knows: give it a name, an
 * address and a password, and it works the server out. Manual setup is one
 * radio button away because automatic detection cannot succeed for a relay
 * that DNS knows nothing about — an internal smarthost, or the dev inbox.
 */

type Step = 'choose' | 'searching' | 'success' | 'manual';

interface ManualForm {
  displayName: string;
  fromAddress: string;
  replyTo: string;
  host: string;
  port: number;
  encryption: MailEncryption;
  authRequired: boolean;
  username: string;
  password: string;
  makeDefault: boolean;
}

const EMPTY: ManualForm = {
  displayName: '',
  fromAddress: '',
  replyTo: '',
  host: '',
  port: 587,
  encryption: 'STARTTLS',
  authRequired: true,
  username: '',
  password: '',
  makeDefault: true,
};

function formFor(account: MailAccountSummary | null): ManualForm {
  if (!account) return EMPTY;
  return {
    displayName: account.displayName,
    fromAddress: account.fromAddress,
    replyTo: account.replyTo ?? '',
    host: account.host,
    port: account.port,
    encryption: account.encryption,
    authRequired: account.authRequired,
    username: account.username ?? '',
    password: '',
    makeDefault: account.isDefault,
  };
}

export function MailAccountWizard({
  editing,
  onDone,
  onCancel,
}: {
  editing: MailAccountSummary | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  // Editing an account skips discovery: the server is already known and the
  // administrator is here to change one field, not to find it again.
  const [step, setStep] = useState<Step>(editing ? 'manual' : 'choose');
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');

  const [name, setName] = useState(editing?.displayName ?? '');
  const [email, setEmail] = useState(editing?.fromAddress ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const [form, setForm] = useState<ManualForm>(formFor(editing));
  const [discovery, setDiscovery] = useState<MailAutodiscoverResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const set = <K extends keyof ManualForm>(key: K, value: ManualForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const saveAccount = async (payload: ManualForm, providerKey: string | null) => {
    const body = {
      displayName: payload.displayName,
      fromAddress: payload.fromAddress,
      replyTo: payload.replyTo || undefined,
      host: payload.host,
      port: payload.port,
      encryption: payload.encryption,
      authRequired: payload.authRequired,
      username: payload.authRequired ? payload.username : undefined,
      // Omitted rather than sent empty, so an edit that leaves the box blank
      // keeps the stored password instead of clearing it.
      password: payload.password ? payload.password : undefined,
      providerKey: providerKey ?? undefined,
      makeDefault: payload.makeDefault,
      isActive: true,
    };

    if (editing) {
      await api(`/api/v1/admin/mail/accounts/${editing.id}`, { method: 'PUT', body });
    } else {
      await api('/api/v1/admin/mail/accounts', { method: 'POST', body });
    }
  };

  const runAutodiscover = async () => {
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setError(null);
    setBusy(true);
    setStep('searching');

    try {
      const result = await api<MailAutodiscoverResult>('/api/v1/admin/mail/autodiscover', {
        method: 'POST',
        body: { email, password },
      });
      setDiscovery(result);

      if (result.found && result.settings) {
        const configured: ManualForm = {
          ...EMPTY,
          displayName: name,
          fromAddress: email,
          host: result.settings.host,
          port: result.settings.port,
          encryption: result.settings.encryption,
          authRequired: result.settings.authRequired,
          username: result.settings.username,
          password,
          makeDefault: true,
        };
        setForm(configured);
        await saveAccount(configured, result.provider?.key ?? null);
        setStep('success');
        return;
      }

      // Detection failed. Carry everything typed so far into manual setup —
      // retyping an address and password to fix one wrong port is a poor
      // consolation prize.
      setForm({
        ...EMPTY,
        displayName: name,
        fromAddress: email,
        host: result.suggestion?.host ?? '',
        port: result.suggestion?.port ?? 587,
        encryption: result.suggestion?.encryption ?? 'STARTTLS',
        username: result.suggestion?.username ?? email,
        password,
        makeDefault: true,
      });
      setStep('manual');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The search could not be completed.');
      setStep('choose');
    } finally {
      setBusy(false);
    }
  };

  const testSettings = async () => {
    setBusy(true);
    setTestResult(null);
    try {
      const result = await api<{ ok: boolean; message: string }>(
        '/api/v1/admin/mail/test-settings',
        {
          method: 'POST',
          body: {
            host: form.host,
            port: form.port,
            encryption: form.encryption,
            authRequired: form.authRequired,
            username: form.username,
            password: form.password,
            accountId: editing?.id,
          },
        },
      );
      setTestResult(result);
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof ApiError ? err.message : 'The test could not be run.',
      });
    } finally {
      setBusy(false);
    }
  };

  const saveManual = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveAccount(form, discovery?.provider?.key ?? editing?.providerKey ?? null);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The account could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  // --- Step 1: auto or manual ------------------------------------------------
  if (step === 'choose') {
    return (
      <div className="space-y-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Auto Account Setup</h2>
          <p className="text-sm text-slate-500">
            The portal can configure many mail accounts automatically.
          </p>
        </div>

        {error && <Alert kind="danger">{error}</Alert>}

        <label className="flex items-start gap-2">
          <input
            type="radio"
            checked={mode === 'auto'}
            onChange={() => setMode('auto')}
            className="mt-1"
          />
          <span className="text-sm font-medium text-slate-800">E-mail Account</span>
        </label>

        <fieldset
          disabled={mode !== 'auto'}
          className={mode === 'auto' ? 'space-y-3 pl-6' : 'space-y-3 pl-6 opacity-50'}
        >
          <Field label="Your Name" hint="Example: Ellen Adams" required>
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="UAE E-Invoicing Portal"
            />
          </Field>
          <Field label="E-mail Address" hint="Example: ellen@contoso.com" required>
            <input
              className={inputClass}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="no-reply@yourcompany.ae"
            />
          </Field>
          <Field label="Password" required>
            <input
              className={inputClass}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field
            label="Retype Password"
            hint="Type the password your mail provider has given you."
            error={confirm && password !== confirm ? 'The passwords do not match.' : undefined}
            required
          >
            <input
              className={inputClass}
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
        </fieldset>

        <label className="flex items-start gap-2">
          <input
            type="radio"
            checked={mode === 'manual'}
            onChange={() => setMode('manual')}
            className="mt-1"
          />
          <span className="text-sm font-medium text-slate-800">
            Manual setup or additional server types
          </span>
        </label>

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button onClick={onCancel}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || (mode === 'auto' && (!name || !email || !password))}
            onClick={() => {
              if (mode === 'manual') {
                setForm({ ...EMPTY, displayName: name, fromAddress: email, username: email });
                setStep('manual');
              } else {
                void runAutodiscover();
              }
            }}
          >
            Next
          </Button>
        </div>
      </div>
    );
  }

  // --- Step 2: searching -----------------------------------------------------
  if (step === 'searching') {
    return (
      <div className="space-y-4">
        <h2 className="text-base font-semibold text-slate-900">
          Searching for your mail server settings
        </h2>
        <p className="text-sm text-slate-500">
          Configuring the outgoing server for <strong>{email}</strong>. This can take a few seconds
          while each candidate is tried.
        </p>
        <Spinner label="Establishing network connection and signing in…" />
      </div>
    );
  }

  // --- Step 3: configured ----------------------------------------------------
  if (step === 'success') {
    return (
      <div className="space-y-4">
        <Alert kind="ok" title="Your account has been set up">
          <p className="mt-1">
            {form.host}:{form.port} · {MAIL_ENCRYPTION_LABELS[form.encryption]}
          </p>
        </Alert>

        {discovery?.provider?.note && (
          <Alert kind="info" title={discovery.provider.label}>
            {discovery.provider.note}
          </Alert>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button variant="primary" onClick={onDone}>
            Finish
          </Button>
        </div>
      </div>
    );
  }

  // --- Manual setup ----------------------------------------------------------
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-slate-900">
          {editing ? 'Change account settings' : 'Outgoing server settings'}
        </h2>
        <p className="text-sm text-slate-500">
          Enter the outgoing (SMTP) details your provider gave you.
        </p>
      </div>

      {discovery && !discovery.found && <Alert kind="warn">{discovery.message}</Alert>}
      {discovery?.provider?.note && (
        <Alert kind="info" title={discovery.provider.label}>
          {discovery.provider.note}
        </Alert>
      )}
      {error && <Alert kind="danger">{error}</Alert>}

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Your Name" required>
          <input
            className={inputClass}
            value={form.displayName}
            onChange={(e) => set('displayName', e.target.value)}
          />
        </Field>
        <Field label="E-mail Address" hint="Messages are sent from this address." required>
          <input
            className={inputClass}
            type="email"
            value={form.fromAddress}
            onChange={(e) => set('fromAddress', e.target.value)}
          />
        </Field>

        <Field label="Outgoing mail server (SMTP)" required>
          <input
            className={inputClass}
            value={form.host}
            onChange={(e) => set('host', e.target.value)}
            placeholder="smtp.yourcompany.ae"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Port" required>
            <input
              className={inputClass}
              type="number"
              value={form.port}
              onChange={(e) => set('port', Number(e.target.value))}
            />
          </Field>
          <Field label="Encryption">
            <select
              className={inputClass}
              value={form.encryption}
              onChange={(e) => {
                const encryption = e.target.value as MailEncryption;
                set('encryption', encryption);
                // The port almost always follows the encryption choice, so
                // moving it too saves the most common misconfiguration.
                if (encryption === 'SSL' && form.port === 587) set('port', 465);
                if (encryption === 'STARTTLS' && form.port === 465) set('port', 587);
              }}
            >
              {Object.entries(MAIL_ENCRYPTION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Reply-to address" hint="Optional. Replies go here instead of the sender.">
          <input
            className={inputClass}
            type="email"
            value={form.replyTo}
            onChange={(e) => set('replyTo', e.target.value)}
          />
        </Field>
      </div>

      <fieldset className="space-y-3 rounded-md border border-slate-200 p-4">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Logon information
        </legend>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.authRequired}
            onChange={(e) => set('authRequired', e.target.checked)}
          />
          My outgoing server requires authentication
        </label>

        {form.authRequired && (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="User Name" required>
              <input
                className={inputClass}
                value={form.username}
                onChange={(e) => set('username', e.target.value)}
              />
            </Field>
            <Field
              label="Password"
              hint={
                editing?.hasPassword
                  ? 'Leave blank to keep the stored password.'
                  : 'Many providers require an app-specific password.'
              }
            >
              <input
                className={inputClass}
                type="password"
                value={form.password}
                onChange={(e) => set('password', e.target.value)}
              />
            </Field>
          </div>
        )}
      </fieldset>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={form.makeDefault}
          onChange={(e) => set('makeDefault', e.target.checked)}
        />
        Send portal e-mail from this account
      </label>

      {testResult && (
        <Alert kind={testResult.ok ? 'ok' : 'danger'} title="Test Account Settings">
          {testResult.message}
        </Alert>
      )}

      {discovery && discovery.attempts.length > 0 && (
        <details className="rounded-md border border-slate-200 p-3 text-xs text-slate-600">
          <summary className="cursor-pointer font-medium text-slate-700">
            What was tried ({discovery.attempts.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {discovery.attempts.map((attempt, index) => (
              <li key={`${attempt.host}:${attempt.port}:${index}`} className="font-mono">
                {attempt.ok ? '✓' : '✗'} {attempt.host}:{attempt.port} · {attempt.encryption} ·{' '}
                {attempt.username} — {attempt.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="flex justify-between gap-2 border-t border-slate-200 pt-4">
        <Button onClick={() => void testSettings()} disabled={busy || !form.host}>
          Test Account Settings…
        </Button>
        <div className="flex gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || !form.host || !form.displayName || !form.fromAddress}
            onClick={() => void saveManual()}
          >
            {editing ? 'Save changes' : 'Save account'}
          </Button>
        </div>
      </div>
    </div>
  );
}
