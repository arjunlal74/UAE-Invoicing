import { API_KEY_SCOPES, type ApiKeySummary, type CreatedApiKey } from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Modal,
  PageHeader,
  Spinner,
  cx,
  formatDateTime,
  inputClass,
} from '../../components/ui';
import { ApiError, api } from '../../lib/api';

/**
 * API keys for ingestion channel 1 (SRS v2.1 §1.2).
 *
 * The screen is shaped by the one fact that governs everything about API keys:
 * the token is shown once and never again. So the create flow ends in a modal
 * the operator has to deliberately dismiss, the list can only ever show a
 * prefix, and "I lost it" is answered by issuing a new key rather than by
 * looking the old one up.
 */

/** Plain-English wording for each scope, since the operator is not a developer. */
const SCOPE_LABELS: Record<string, { label: string; description: string; caution?: boolean }> = {
  'invoice.read': {
    label: 'Read invoices',
    description: 'Look up documents and poll for clearance status.',
  },
  'invoice.edit': {
    label: 'Prepare invoices',
    description: 'Create documents and correct staged rows.',
  },
  'invoice.submit_for_approval': {
    label: 'Submit for approval',
    description: 'Post invoices that wait for your tax approver to release them.',
  },
  'invoice.submit': {
    label: 'File with the FTA',
    description: 'Post invoices that go straight to the tax authority, unattended.',
    caution: true,
  },
  'directory.read': { label: 'Read customers and suppliers', description: 'Look up directory records.' },
  'directory.manage': {
    label: 'Manage customers and suppliers',
    description: 'Create and update directory records.',
  },
  'ap.read': { label: 'Read purchase invoices', description: 'Read the inbound AP inbox.' },
  'reports.read': { label: 'Read reports', description: 'Run the AR and AP reporting suite.' },
};

const DEFAULT_SCOPES = ['invoice.read', 'invoice.submit_for_approval'];

export function ApiKeysPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<CreatedApiKey | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api<{ items: ApiKeySummary[] }>('/api/v1/api-keys'),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/v1/api-keys/${id}/revoke`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['api-keys'] }),
  });

  if (isLoading) return <Spinner label="Loading keys…" />;

  const keys = data?.items ?? [];
  const active = keys.filter((key) => !key.revokedAt);
  const sftpAccounts = active
    .map((key) => key.sftpUsername)
    .filter((name): name is string => Boolean(name));

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="API keys"
        description="Credentials for an ERP or middleware that posts invoices to this platform directly."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            Create key
          </Button>
        }
      />

      <Card>
        {keys.length === 0 ? (
          <EmptyState
            title="No API keys"
            description="Create one to let your ERP post invoices without anyone signing in."
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Key</th>
                <th className="pb-2 font-medium">Permissions</th>
                <th className="pb-2 font-medium">SFTP</th>
                <th className="pb-2 font-medium">Last used</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {keys.map((key) => (
                <tr key={key.id} className={cx(key.revokedAt && 'text-slate-400')}>
                  <td className="py-2">
                    <span className="font-medium text-slate-800">{key.name}</span>
                    {key.revokedAt && (
                      <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                        revoked {formatDateTime(key.revokedAt)}
                      </span>
                    )}
                    {!key.revokedAt && key.expiresAt && (
                      <span className="ml-2 text-xs text-slate-500">
                        expires {formatDateTime(key.expiresAt)}
                      </span>
                    )}
                    <p className="text-xs text-slate-500">
                      Created {formatDateTime(key.createdAt)}
                      {key.createdByName ? ` by ${key.createdByName}` : ''}
                    </p>
                  </td>
                  <td className="py-2 font-mono text-xs text-slate-500">{key.keyPrefix}…</td>
                  <td className="py-2 text-xs text-slate-600">
                    {key.scopes.map((scope) => SCOPE_LABELS[scope]?.label ?? scope).join(', ')}
                  </td>
                  <td className="py-2 font-mono text-xs text-slate-600">
                    {key.sftpUsername ?? <span className="font-sans text-slate-400">—</span>}
                  </td>
                  <td className="py-2 text-xs text-slate-500">
                    {key.lastUsedAt ? formatDateTime(key.lastUsedAt) : 'never'}
                  </td>
                  <td className="py-2 text-right">
                    {!key.revokedAt && (
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(key.id)}
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {revoke.error && (
          <div className="mt-3">
            <Alert kind="danger">
              {revoke.error instanceof ApiError
                ? revoke.error.message
                : 'That key could not be revoked.'}
            </Alert>
          </div>
        )}
      </Card>

      {active.length > 0 && <UsageGuide />}
      {sftpAccounts.length > 0 && <SftpGuide usernames={sftpAccounts} />}

      {creating && (
        <CreateKeyModal
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            setIssued(created);
            queryClient.invalidateQueries({ queryKey: ['api-keys'] });
          }}
        />
      )}

      {issued && <IssuedKeyModal issued={issued} onClose={() => setIssued(null)} />}
    </div>
  );
}

function CreateKeyModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: CreatedApiKey) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [expiresAt, setExpiresAt] = useState('');
  const [sftpUsername, setSftpUsername] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api<CreatedApiKey>('/api/v1/api-keys', {
        method: 'POST',
        body: {
          name,
          scopes,
          // A date input gives a day; the API wants an instant. End of that day
          // in Gulf time, so a key set to expire "on the 30th" works all of it.
          expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59+04:00`).toISOString() : null,
          sftpUsername: sftpUsername.trim() || null,
        },
      }),
    onSuccess: onCreated,
  });

  const toggle = (scope: string) =>
    setScopes((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );

  return (
    <Modal title="Create an API key" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Name" hint="What system will use this key? It appears in the audit trail.">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. SAP production connector"
          />
        </Field>

        <div>
          <p className="mb-2 text-sm font-medium text-slate-700">Permissions</p>
          <div className="space-y-1.5">
            {API_KEY_SCOPES.map((scope) => {
              const meta = SCOPE_LABELS[scope];
              return (
                <label
                  key={scope}
                  className="flex cursor-pointer items-start gap-2.5 rounded-md border border-slate-200 p-2.5 hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={scopes.includes(scope)}
                    onChange={() => toggle(scope)}
                  />
                  <span>
                    <span
                      className={cx(
                        'block text-sm font-medium',
                        meta?.caution ? 'text-danger-700' : 'text-slate-800',
                      )}
                    >
                      {meta?.label ?? scope}
                    </span>
                    <span className="block text-xs text-slate-500">{meta?.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        {scopes.includes('invoice.submit') && (
          <Alert kind="warn" title="This key can file with the tax authority">
            Invoices posted with it are filed without anyone reviewing them. Grant it only to a
            system whose output you already trust; otherwise use “Submit for approval”, which parks
            each document for your tax approver.
          </Alert>
        )}

        <Field
          label="SFTP account (optional)"
          hint="Give the key a drop directory for an ERP that exports files instead of calling an API. It cannot be added later — create another key if you need one."
        >
          <input
            className={inputClass}
            value={sftpUsername}
            onChange={(e) => setSftpUsername(e.target.value.toLowerCase())}
            placeholder="e.g. albahar-sap"
          />
        </Field>

        {sftpUsername.trim() && (
          <Alert kind="info" title="What the drop directory does">
            Files left in <code className="font-mono text-xs">/inbox</code> are processed with{' '}
            <em>this key's</em> permissions, and a receipt is written back beside the file in{' '}
            <code className="font-mono text-xs">/processed</code> or{' '}
            <code className="font-mono text-xs">/failed</code>. Ask your administrator to create
            the matching SFTP account. Revoking this key stops the directory being read — but the
            SFTP account&rsquo;s own password is separate, so disable that too if a credential has
            leaked.
          </Alert>
        )}

        <Field label="Expires" hint="Leave blank for a key that does not expire on its own.">
          <input
            className={inputClass}
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </Field>

        {create.error && (
          <Alert kind="danger">
            {create.error instanceof ApiError
              ? create.error.message
              : 'That key could not be created.'}
          </Alert>
        )}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!name.trim() || scopes.length === 0 || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Creating…' : 'Create key'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The one time the token is visible.
 *
 * No auto-dismiss and no click-outside-to-close: the modal that holds a secret
 * nobody can retrieve later should not be dismissable by a stray click.
 */
function IssuedKeyModal({ issued, onClose }: { issued: CreatedApiKey; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <Modal title="Your new API key" onClose={onClose} dismissOnBackdrop={false}>
      <div className="space-y-4">
        <Alert kind="warn" title="Copy this now">
          This is the only time the key is shown. We store a hash of it, so it cannot be recovered —
          if it is lost, revoke this key and create another.
        </Alert>

        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <code className="block break-all font-mono text-xs text-slate-800">{issued.token}</code>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-600">{issued.key.name}</span>
          <Button
            onClick={() => {
              void navigator.clipboard?.writeText(issued.token).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy to clipboard'}
          </Button>
        </div>

        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            I have saved it
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** The smallest thing an integrator needs to make their first call. */
function UsageGuide() {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return (
    <Card title="Using the API">
      <p className="mb-3 text-sm text-slate-600">
        Send the key as <code className="font-mono text-xs">X-API-Key</code>, or as a bearer token.
        Set an <code className="font-mono text-xs">Idempotency-Key</code> per document so a timed-out
        retry cannot file the same invoice twice.
      </p>
      <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
        {`curl -X POST ${origin}/api/v1/invoices \\
  -H "X-API-Key: uaeinv_live_…" \\
  -H "Idempotency-Key: erp-doc-88421" \\
  -H "content-type: application/json" \\
  -d '{
    "invoiceNumber": "INV-2026-00042",
    "buyer": { "customerCode": "CUST-014" },
    "lines": [
      { "description": "Consultancy", "quantity": "10",
        "unitPrice": "500.00", "vatCategory": "S" }
    ]
  }'

# then poll for the tax authority's verdict
curl ${origin}/api/v1/invoices/status/INV-2026-00042 \\
  -H "X-API-Key: uaeinv_live_…"`}
      </pre>
    </Card>
  );
}

/** The other half of channel 1, for an ERP that exports files on a schedule. */
function SftpGuide({ usernames }: { usernames: string[] }) {
  return (
    <Card title="Using the SFTP drop">
      <p className="mb-3 text-sm text-slate-600">
        Upload into <code className="font-mono text-xs">inbox/</code>. The platform picks the file
        up once it stops changing, and writes{' '}
        <code className="font-mono text-xs">&lt;file&gt;.receipt.json</code> beside the moved file
        in <code className="font-mono text-xs">processed/</code> or{' '}
        <code className="font-mono text-xs">failed/</code>. A byte-identical re-send is refused
        rather than filed twice.
      </p>
      <ul className="mb-3 space-y-1 text-sm text-slate-600">
        <li>
          <code className="font-mono text-xs">.json</code> — one document or an array, the same body
          the REST endpoint takes. Each is filed on its own, so one bad document does not cost you
          the rest of the file.
        </li>
        <li>
          <code className="font-mono text-xs">.xlsx</code> — the platform&rsquo;s invoice template.
          It becomes a batch in the staging grid for someone to review, and the receipt says which
          one.
        </li>
      </ul>
      <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
        {`sftp -P 2222 ${usernames[0] ?? 'your-account'}@sftp.example.ae
> cd inbox
> put invoices-2026-08-27.json
> cd ../processed
> get invoices-2026-08-27.json.receipt.json`}
      </pre>
    </Card>
  );
}
