import type { PartnerStaffMember } from '@uae/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const staff: PartnerStaffMember[] = [
  {
    id: 'u1',
    email: 'partner@gulfadvisory.local',
    fullName: 'Layla Haddad',
    role: 'PARTNER_ADMIN',
    isActive: true,
    hasSignedIn: true,
    mfaEnabled: true,
    lastLoginAt: '2026-08-31T07:00:00.000Z',
    createdAt: '2026-08-01T09:00:00.000Z',
  },
  {
    id: 'u2',
    email: 'junior@gulfadvisory.local',
    fullName: 'Omar Nasser',
    role: 'PARTNER_ADMIN',
    isActive: true,
    // Invited and never accepted: cannot sign in, cannot be authorised yet.
    hasSignedIn: false,
    mfaEnabled: false,
    lastLoginAt: null,
    createdAt: '2026-08-28T09:00:00.000Z',
  },
  {
    id: 'u3',
    email: 'former@gulfadvisory.local',
    fullName: 'Noura Salem',
    role: 'PARTNER_ADMIN',
    isActive: false,
    hasSignedIn: true,
    mfaEnabled: false,
    lastLoginAt: '2026-07-02T11:00:00.000Z',
    createdAt: '2026-06-01T09:00:00.000Z',
  },
];

const posted: { path: string; options?: { method?: string } }[] = [];

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    api: vi.fn((path: string, options?: { method?: string }) => {
      if (options?.method) posted.push({ path, options });
      if (path.startsWith('/api/v1/partner/staff')) {
        return Promise.resolve({ items: staff, total: staff.length, page: 1, pageSize: 3 });
      }
      return Promise.resolve({});
    }),
  };
});

const { PartnerStaffPage } = await import('../pages/partner/PartnerStaffPage');
const { useAuthStore } = await import('../stores/auth');

function mount(route = '/partner/staff') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <PartnerStaffPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  posted.length = 0;
  // The page has to know which row is the person reading it.
  useAuthStore.setState({
    user: {
      id: 'u1',
      email: 'partner@gulfadvisory.local',
      fullName: 'Layla Haddad',
      role: 'PARTNER_ADMIN',
      tenantId: 'p1',
      tenantName: 'Gulf Advisory Partners',
      tenantStatus: 'ACTIVE',
      mfaEnabled: true,
      mustRotatePassword: false,
      actingFor: null,
    },
  });
});

describe('partner staff', () => {
  it('lists the firm and marks who cannot sign in', async () => {
    mount();

    expect(await screen.findByText('Layla Haddad')).toBeInTheDocument();

    const invited = screen.getByText('Omar Nasser').closest('tr')!;
    expect(within(invited).getByText('invitation not accepted')).toBeInTheDocument();

    const lockedOut = screen.getByText('Noura Salem').closest('tr')!;
    expect(within(lockedOut).getByText('locked')).toBeInTheDocument();
  });

  /**
   * The actions are glyphs, so their accessible names carry the whole verb —
   * and the lock has to say which direction it goes in, because the same button
   * locks one row and unlocks another.
   */
  it('names the three actions, and turns the lock round on a locked account', async () => {
    mount();

    const active = (await screen.findByText('Omar Nasser')).closest('tr')!;
    expect(within(active).getByRole('button', { name: 'View' })).toBeEnabled();
    expect(within(active).getByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(within(active).getByRole('button', { name: 'Lock account' })).toBeEnabled();

    const lockedOut = screen.getByText('Noura Salem').closest('tr')!;
    expect(within(lockedOut).getByRole('button', { name: 'Unlock account' })).toBeEnabled();
  });

  it('refuses to lock the account the reader is signed in with', async () => {
    mount();

    const mine = (await screen.findByText('Layla Haddad')).closest('tr')!;
    expect(within(mine).getByRole('button', { name: 'Lock account' })).toBeDisabled();
  });

  it('locks a colleague through the lock endpoint', async () => {
    const user = userEvent.setup();
    mount();

    const row = (await screen.findByText('Omar Nasser')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Lock account' }));

    expect(posted).toContainEqual({
      path: '/api/v1/partner/staff/u2/lock',
      options: { method: 'POST' },
    });
  });

  it('opens a colleague read-only, and holds their address once they have signed in', async () => {
    const user = userEvent.setup();
    mount();

    const row = (await screen.findByText('Layla Haddad')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'View' }));

    expect(await screen.findByRole('heading', { name: 'Layla Haddad' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('partner@gulfadvisory.local')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });
});
