import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const dashboard = {
  partnerName: 'Gulf Advisory Partners',
  subTenants: {
    total: 3,
    byStatus: { ACTIVE: 2, PENDING: 1 },
    byMode: { COLLABORATIVE: 2, FULLY_MANAGED_CUSTODY: 1 },
  },
  users: { total: 5, active: 4, pendingInvites: 1 },
  invoices: { total: 40, accepted: 30, rejected: 2, last30Days: 12 },
  inventory: {
    purchasedUnits: 100000,
    allocatedUnits: 5000,
    unallocatedUnits: 95000,
    consumedUnits: 40,
    remainingUnits: 99960,
  },
  needsAttention: {
    subTenantsPendingActivation: 1,
    aspNotConfigured: 1,
    pendingInvites: 1,
    subTenantsWithoutUnits: 2,
    subTenantsBelowBuffer: 0,
    custodyWithoutStaff: 1,
    rejectedByFta: 2,
    stuckTransmissions: 0,
    validationFailed: 0,
    poolFullyAllocated: false,
  },
  topSubTenants: [
    {
      tenantId: 't1',
      tenantName: 'Desert Logistics LLC',
      status: 'ACTIVE',
      invoices: 12,
      accepted: 10,
      rejected: 2,
      valueAed: '52500.00',
    },
  ],
  recentActivity: [
    {
      id: '1',
      action: 'SUB_TENANT_CREATED',
      actorName: 'layla@gulfadvisory.local',
      tenantName: 'Desert Logistics LLC',
      createdAt: '2026-08-30T10:00:00.000Z',
    },
  ],
};

const subTenants = {
  items: [
    {
      id: 't1',
      companyCode: 'DESERTLOG',
      legalNameEn: 'Desert Logistics LLC',
      legalNameAr: 'الصحراء للخدمات اللوجستية',
      registeredAddress: {
        street: 'Jebel Ali',
        city: 'Dubai',
        emirate: 'Dubai',
        postalCode: '',
        countryCode: 'AE',
      },
      trn: '100583920100003',
      peppolParticipantId: '0235:100583920100003',
      status: 'ACTIVE',
      isLocked: false,
      aspStatus: 'ACTIVE',
      provisioningMode: 'COLLABORATIVE',
      custodyStaffCount: 0,
      invoiceCount: 12,
      userCount: 2,
      createdAt: '2026-08-30T10:00:00.000Z',
    },
    {
      id: 't2',
      companyCode: 'GULFMARINE',
      legalNameEn: 'Gulf Marine Services',
      legalNameAr: 'الخليج للخدمات البحرية',
      registeredAddress: {
        street: 'Mina Zayed',
        city: 'Abu Dhabi',
        emirate: 'Abu Dhabi',
        postalCode: '',
        countryCode: 'AE',
      },
      trn: '100583920100004',
      peppolParticipantId: null,
      status: 'ACTIVE',
      // Locked by the platform, so this row's edit must be refused on the row.
      isLocked: true,
      aspStatus: 'ACTIVE',
      provisioningMode: 'FULLY_MANAGED_CUSTODY',
      custodyStaffCount: 0,
      invoiceCount: 0,
      userCount: 0,
      createdAt: '2026-08-30T10:00:00.000Z',
    },
  ],
  total: 2,
  page: 1,
  pageSize: 2,
};

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    api: vi.fn((path: string) => {
      if (path.startsWith('/api/v1/partner/dashboard')) return Promise.resolve(dashboard);
      if (path.startsWith('/api/v1/partner/sub-tenants')) return Promise.resolve(subTenants);
      if (path.startsWith('/api/v1/partner/overview')) {
        return Promise.resolve({
          partnerName: 'Gulf Advisory Partners',
          subTenantCount: 3,
          activeSubTenantCount: 2,
          invoiceCount: 40,
          acceptedInvoiceCount: 30,
        });
      }
      if (path.startsWith('/api/v1/billing/balance')) return Promise.resolve({ bundles: [] });
      return Promise.resolve({});
    }),
  };
});

const { PartnerDashboardPage } = await import('../pages/partner/PartnerDashboardPage');
const { PartnerSubTenantsPage } = await import('../pages/partner/PartnerSubTenantsPage');

function mount(ui: JSX.Element, route = '/partner') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('partner console', () => {
  it('shows the attention tiles and links them at the rows they count', async () => {
    mount(<PartnerDashboardPage />);

    expect(await screen.findByText('Gulf Advisory Partners')).toBeInTheDocument();
    expect(screen.getByText('Clients pending activation').closest('a')).toHaveAttribute(
      'href',
      '/partner/sub-tenants?status=PENDING',
    );
    expect(screen.getByText('Provider connections not live').closest('a')).toHaveAttribute(
      'href',
      '/partner/sub-tenants?aspStatus=NOT_LIVE',
    );
    expect(screen.getByText('Invitations not accepted').closest('a')).toHaveAttribute(
      'href',
      '/partner/sub-tenants?invites=pending',
    );
    // A partner has no invoice screen, so this one is a read-out, not a link.
    expect(screen.getByText('Rejected by the FTA').closest('a')).toBeNull();
    // Zero is not attention.
    expect(screen.queryByText('Slices below their floor')).toBeNull();
    // Twice: the busiest-clients table and the activity feed underneath it.
    expect(screen.getAllByText('Desert Logistics LLC')).toHaveLength(2);
  });

  it('lists sub-tenants and seeds its filters from the URL', async () => {
    mount(<PartnerSubTenantsPage />, '/partner/sub-tenants?status=PENDING');

    expect(await screen.findByText('Desert Logistics LLC')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Pending')).toBeInTheDocument();
    // The form is a dialog now, so nothing of it is on the page until asked for.
    expect(screen.queryByText('Company code')).toBeNull();
    expect(screen.getByRole('button', { name: 'Onboard a sub-tenant' })).toBeInTheDocument();
  });

  /**
   * §3. The two modes are only worth distinguishing if the row does something
   * different: a custody client can be opened and staffed, a collaborative one
   * cannot — there is nobody else's books to open.
   */
  it('offers custody actions only on the clients held in custody', async () => {
    mount(<PartnerSubTenantsPage />, '/partner/sub-tenants');

    const custodyRow = (await screen.findByText('Gulf Marine Services')).closest('tr')!;
    const collaborativeRow = screen.getByText('Desert Logistics LLC').closest('tr')!;

    expect(within(custodyRow).getByText('Custody')).toBeInTheDocument();
    expect(within(custodyRow).getByRole('button', { name: 'Open books' })).toBeInTheDocument();
    expect(
      within(custodyRow).getByRole('button', { name: 'Authorised staff' }),
    ).toBeInTheDocument();
    // Nobody authorised is called out on the row, not left to be inferred.
    expect(within(custodyRow).getByText('nobody authorised')).toBeInTheDocument();

    expect(within(collaborativeRow).getByText('Collaborative')).toBeInTheDocument();
    expect(within(collaborativeRow).queryByRole('button', { name: 'Open books' })).toBeNull();
    expect(within(collaborativeRow).queryByRole('button', { name: 'Authorised staff' })).toBeNull();
    // Both can move between modes.
    expect(
      within(collaborativeRow).getByRole('button', { name: 'Change provisioning mode' }),
    ).toBeInTheDocument();
  });

  /**
   * The actions are glyphs, so their accessible names are the only thing a
   * screen reader or a keyboard user has to go on — and a locked record must
   * refuse the edit on the row rather than at the server.
   */
  it('names every icon action, and refuses to edit a locked record', async () => {
    mount(<PartnerSubTenantsPage />, '/partner/sub-tenants');

    const row = (await screen.findByText('Desert Logistics LLC')).closest('tr')!;
    expect(within(row).getByRole('button', { name: 'View' })).toBeEnabled();
    expect(within(row).getByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(within(row).getByRole('button', { name: 'Allocate units' })).toBeInTheDocument();

    const locked = screen.getByText('Gulf Marine Services').closest('tr')!;
    expect(within(locked).getByRole('button', { name: 'View' })).toBeEnabled();
    expect(within(locked).getByRole('button', { name: 'Edit' })).toBeDisabled();
  });

  it('opens a client record read-only from the view action', async () => {
    const user = userEvent.setup();
    mount(<PartnerSubTenantsPage />, '/partner/sub-tenants');

    const row = (await screen.findByText('Desert Logistics LLC')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'View' }));

    const dialog = await screen.findByRole('heading', { name: 'Desert Logistics LLC' });
    expect(dialog).toBeInTheDocument();
    // Read-only: the names are shown, and none of them can be typed into.
    expect(screen.getByDisplayValue('Desert Logistics LLC')).toBeDisabled();
    expect(screen.getByDisplayValue('100583920100003')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();

    // Scoped to the dialog: the list behind it has a Provisioning column of
    // its own, and an unscoped query would match the header just as happily.
    const panel = within(dialog.closest('header')!.parentElement!);

    // The whole record, not the four editable fields: a fact you cannot change
    // is still a fact somebody opened the row to read.
    for (const label of [
      'Legal name (English)',
      'Legal name (Arabic)',
      'Company code',
      'TRN',
      'Street address',
      'Emirate',
      'Peppol participant id',
      'Provisioning',
      'Their own users',
      'Account',
      'Provider connection',
      'Invoices filed',
      'Onboarded',
    ]) {
      expect(panel.getByText(label)).toBeInTheDocument();
    }
  });
});
