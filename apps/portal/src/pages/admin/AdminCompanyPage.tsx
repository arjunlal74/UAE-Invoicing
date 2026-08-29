import type { PlatformCompany } from '@uae/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EMIRATES } from '@uae/domain';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Field,
  PageHeader,
  Spinner,
  inputClass,
} from '../../components/ui';
import { ApiError, api } from '../../lib/api';

/**
 * The platform owner's own company.
 *
 * Every tenant on this system has a legal identity on file and the company
 * running it had none — the name on its correspondence was a deployment
 * setting. This is the equivalent of a tenant's Company profile, one level up.
 */
export function AdminCompanyPage() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['platform-company'],
    queryFn: () => api<PlatformCompany>('/api/v1/admin/platform/company'),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Platform company"
        description="Who is operating this platform. Its name, TRN and logo are what appear on the bundle invoices and the mail this system sends."
      />
      {isLoading || !data ? (
        <Spinner label="Loading company…" />
      ) : (
        <>
          <LogoCard
            company={data}
            onChanged={() => queryClient.invalidateQueries({ queryKey: ['platform-company'] })}
          />
          <DetailsCard
            company={data}
            onSaved={() => queryClient.invalidateQueries({ queryKey: ['platform-company'] })}
          />
        </>
      )}
    </div>
  );
}

function LogoCard({
  company,
  onChanged,
}: {
  company: PlatformCompany;
  onChanged: () => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  // Preview the file before it is uploaded, and release the object URL when it
  // is replaced — a blob URL held after its file is gone is a leak the browser
  // cannot clean up on its own.
  useEffect(() => {
    if (!chosen) return setPreview(null);
    const url = URL.createObjectURL(chosen);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [chosen]);

  const clearChoice = () => {
    setChosen(null);
    if (picker.current) picker.current.value = '';
  };

  const upload = useMutation({
    mutationFn: () => {
      const body = new FormData();
      body.append('file', chosen!);
      return api('/api/v1/admin/platform/company/logo', { method: 'POST', formData: body });
    },
    onSuccess: () => {
      clearChoice();
      onChanged();
    },
  });

  const remove = useMutation({
    mutationFn: () => api('/api/v1/admin/platform/company/logo', { method: 'DELETE' }),
    onSuccess: onChanged,
  });

  // The stored logo is served by its own URL rather than embedded in the
  // record, so the cache is busted by the timestamp the record carries.
  const current = company.hasLogo
    ? `/api/v1/platform/logo?v=${encodeURIComponent(company.logoUpdatedAt ?? '')}`
    : null;

  return (
    <Card title="Logo">
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex h-28 w-52 shrink-0 items-center justify-center rounded-md border border-dashed border-slate-300 bg-slate-50 p-2">
          {preview || current ? (
            <img
              src={preview ?? current!}
              alt={`${company.legalNameEn || 'Platform'} logo`}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <span className="text-xs text-slate-400">No logo uploaded</span>
          )}
        </div>

        <div className="min-w-64 flex-1 space-y-3">
          <p className="text-sm text-slate-600">
            PNG, JPEG, SVG or WebP, up to 512KB. A wide, transparent image reads
            best — it is shown against light and dark backgrounds.
          </p>

          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-50"
            onChange={(event) => setChosen(event.target.files?.[0] ?? null)}
          />

          {(upload.error || remove.error) && (
            <Alert kind="danger">
              {(upload.error ?? remove.error) instanceof ApiError
                ? ((upload.error ?? remove.error) as ApiError).message
                : 'That logo could not be saved.'}
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={!chosen || upload.isPending}
              onClick={() => upload.mutate()}
            >
              {upload.isPending ? 'Uploading…' : company.hasLogo ? 'Replace logo' : 'Upload logo'}
            </Button>
            {chosen && <Button onClick={clearChoice}>Cancel</Button>}
            {company.hasLogo && !chosen && (
              <Button disabled={remove.isPending} onClick={() => remove.mutate()}>
                {remove.isPending ? 'Removing…' : 'Remove'}
              </Button>
            )}
            {company.logoFileName && !chosen && (
              <span className="text-xs text-slate-500">{company.logoFileName}</span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

function DetailsCard({ company, onSaved }: { company: PlatformCompany; onSaved: () => void }) {
  const [form, setForm] = useState({
    legalNameEn: company.legalNameEn,
    legalNameAr: company.legalNameAr,
    tradingName: company.tradingName ?? '',
    trn: company.trn ?? '',
    contactEmail: company.contactEmail ?? '',
    contactPhone: company.contactPhone ?? '',
    website: company.website ?? '',
    street: company.registeredAddress?.street ?? '',
    city: company.registeredAddress?.city ?? '',
    // The select has to show something; nothing is stored until it is saved.
    emirate: company.registeredAddress?.emirate ?? EMIRATES[0],
    postalCode: company.registeredAddress?.postalCode ?? '',
  });
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      api('/api/v1/admin/platform/company', {
        method: 'PATCH',
        body: {
          legalNameEn: form.legalNameEn.trim(),
          legalNameAr: form.legalNameAr.trim(),
          // An emptied optional field is a cleared one, not an omitted one.
          tradingName: form.tradingName.trim() || null,
          trn: form.trn.trim() || null,
          contactEmail: form.contactEmail.trim() || null,
          contactPhone: form.contactPhone.trim() || null,
          website: form.website.trim() || null,
          registeredAddress: {
            street: form.street.trim(),
            city: form.city.trim(),
            emirate: form.emirate,
            postalCode: form.postalCode.trim(),
            countryCode: company.registeredAddress?.countryCode || 'AE',
          },
        },
      }),
    onSuccess: () => {
      setSaved(true);
      onSaved();
    },
  });

  const set = (field: keyof typeof form) => (value: string) => {
    setSaved(false);
    setForm((f) => ({ ...f, [field]: value }));
  };

  return (
    <Card title="Registered details">
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Legal name (English)">
            <input
              className={inputClass}
              value={form.legalNameEn}
              onChange={(e) => set('legalNameEn')(e.target.value)}
            />
          </Field>
          <Field label="Legal name (Arabic)">
            <input
              className={`${inputClass} arabic`}
              dir="rtl"
              lang="ar"
              value={form.legalNameAr}
              onChange={(e) => set('legalNameAr')(e.target.value)}
            />
          </Field>
          <Field label="Trading name" hint="If it trades under a name other than its legal one.">
            <input
              className={inputClass}
              value={form.tradingName}
              onChange={(e) => set('tradingName')(e.target.value)}
            />
          </Field>
          <Field label="TRN" hint="15 digits, starting with 1.">
            <input
              className={inputClass}
              inputMode="numeric"
              value={form.trn}
              onChange={(e) => set('trn')(e.target.value)}
              placeholder="100000000000003"
            />
          </Field>
          <Field label="Contact email">
            <input
              className={inputClass}
              type="email"
              value={form.contactEmail}
              onChange={(e) => set('contactEmail')(e.target.value)}
            />
          </Field>
          <Field label="Contact phone">
            <input
              className={inputClass}
              value={form.contactPhone}
              onChange={(e) => set('contactPhone')(e.target.value)}
            />
          </Field>
          <Field label="Website">
            <input
              className={inputClass}
              value={form.website}
              onChange={(e) => set('website')(e.target.value)}
              placeholder="https://"
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Street">
            <input
              className={inputClass}
              value={form.street}
              onChange={(e) => set('street')(e.target.value)}
            />
          </Field>
          <Field label="City">
            <input
              className={inputClass}
              value={form.city}
              onChange={(e) => set('city')(e.target.value)}
            />
          </Field>
          <Field label="Emirate">
            <select
              className={inputClass}
              value={form.emirate}
              onChange={(e) => set('emirate')(e.target.value)}
            >
              {EMIRATES.map((emirate) => (
                <option key={emirate} value={emirate}>
                  {emirate}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Postal code">
            <input
              className={inputClass}
              value={form.postalCode}
              onChange={(e) => set('postalCode')(e.target.value)}
            />
          </Field>
        </div>

        {save.error && (
          <Alert kind="danger">
            {save.error instanceof ApiError
              ? save.error.message
              : 'Those details could not be saved.'}
          </Alert>
        )}

        <div className="flex items-center justify-end gap-3">
          {saved && !save.isPending && <span className="text-xs text-ok-700">Saved.</span>}
          <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save details'}
          </Button>
        </div>
      </div>
    </Card>
  );
}
