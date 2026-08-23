import {
  MAIL_ENCRYPTION_LABELS,
  type MailAccountSummary,
  type MailDeliveryItem,
} from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../../lib/api';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Spinner,
  StatusBadge,
  formatDateTime,
} from '../../components/ui';
import { MailAccountWizard } from './MailAccountWizard';

/**
 * Outgoing mail.
 *
 * Until an account exists here every invitation has to be copied out of the
 * portal and pasted into someone else's mail client, so the empty state leads
 * with the wizard rather than with an explanation.
 */
export function AdminMailPage() {
  const queryClient = useQueryClient();
  const [wizard, setWizard] = useState<{ open: boolean; editing: MailAccountSummary | null }>({
    open: false,
    editing: null,
  });
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const accounts = useQuery({
    queryKey: ['mail-accounts'],
    queryFn: () => api<{ items: MailAccountSummary[] }>('/api/v1/admin/mail/accounts'),
  });

  const deliveries = useQuery({
    queryKey: ['mail-deliveries'],
    queryFn: () => api<{ items: MailDeliveryItem[] }>('/api/v1/admin/mail/deliveries'),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
    void queryClient.invalidateQueries({ queryKey: ['mail-deliveries'] });
  };

  const makeDefault = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/admin/mail/accounts/${id}/default`, { method: 'POST' }),
    onSuccess: refresh,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/admin/mail/accounts/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  const sendTest = useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) =>
      api<{ ok: boolean; message: string }>(`/api/v1/admin/mail/accounts/${id}/send-test`, {
        method: 'POST',
        body: { to },
      }),
    onSuccess: (result) => {
      setNotice({ ok: result.ok, text: result.message });
      refresh();
    },
    onError: (err) =>
      setNotice({
        ok: false,
        text: err instanceof ApiError ? err.message : 'The test message could not be sent.',
      }),
  });

  const items = accounts.data?.items ?? [];

  if (wizard.open) {
    return (
      <div className="mx-auto max-w-3xl">
        <Card title={wizard.editing ? 'Change account' : 'Add account'}>
          <MailAccountWizard
            editing={wizard.editing}
            onDone={() => {
              setWizard({ open: false, editing: null });
              refresh();
            }}
            onCancel={() => setWizard({ open: false, editing: null })}
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Outgoing mail</h1>
        <Button variant="primary" onClick={() => setWizard({ open: true, editing: null })}>
          Add account
        </Button>
      </div>

      {notice && <Alert kind={notice.ok ? 'ok' : 'danger'}>{notice.text}</Alert>}

      <Card title="Accounts">
        {accounts.isLoading ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState
            title="No mail account is configured"
            description="Invitations are not e-mailed until an outgoing account exists — the portal shows the link for an administrator to pass on instead."
          />
        ) : (
          <div className="space-y-3">
            {items.map((account) => (
              <div
                key={account.id}
                className="rounded-md border border-slate-200 p-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium text-slate-900">
                      {account.displayName} &lt;{account.fromAddress}&gt;
                      {account.isDefault && (
                        <span className="ml-2 inline-flex items-center rounded-full bg-ok-50 px-2 py-0.5 text-xs font-medium text-ok-700">
                          Default
                        </span>
                      )}
                    </p>
                    <p className="font-mono text-xs text-slate-500">
                      {account.host}:{account.port} · {MAIL_ENCRYPTION_LABELS[account.encryption]}
                      {account.authRequired ? ` · ${account.username ?? ''}` : ' · no authentication'}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {!account.isDefault && (
                      <Button size="sm" onClick={() => makeDefault.mutate(account.id)}>
                        Make default
                      </Button>
                    )}
                    <Button
                      size="sm"
                      onClick={() => setWizard({ open: true, editing: account })}
                    >
                      Change settings
                    </Button>
                    <Button
                      size="sm"
                      disabled={sendTest.isPending}
                      onClick={() => sendTest.mutate({ id: account.id, to: account.fromAddress })}
                    >
                      Send test message
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(account.id)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>

                {account.lastTestedAt && (
                  <p
                    className={
                      account.lastTestOk
                        ? 'mt-2 text-xs text-ok-700'
                        : 'mt-2 text-xs text-danger-700'
                    }
                  >
                    Last tested {formatDateTime(account.lastTestedAt)} — {account.lastTestResult}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Recent messages">
        {deliveries.isLoading ? (
          <Spinner />
        ) : (deliveries.data?.items.length ?? 0) === 0 ? (
          <p className="text-sm text-slate-500">Nothing has been sent yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="pb-2 font-medium">Sent</th>
                <th className="pb-2 font-medium">To</th>
                <th className="pb-2 font-medium">Subject</th>
                <th className="pb-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {deliveries.data?.items.map((item) => (
                <tr key={item.id}>
                  <td className="py-2 whitespace-nowrap text-slate-500">
                    {formatDateTime(item.sentAt ?? item.createdAt)}
                  </td>
                  <td className="py-2">{item.toAddress}</td>
                  <td className="py-2 text-slate-600">{item.subject}</td>
                  <td className="py-2">
                    <StatusBadge status={item.status} />
                    {item.error && (
                      <p className="mt-1 text-xs text-danger-700">{item.error}</p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
