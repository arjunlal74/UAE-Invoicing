import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { ApiError } from './lib/api';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { LoginPage } from './pages/LoginPage';
import { AdminAuditPage } from './pages/admin/AdminAuditPage';
import { AdminMailPage } from './pages/admin/AdminMailPage';
import { AdminStaffPage } from './pages/admin/AdminStaffPage';
import { AdminTenantDetailPage } from './pages/admin/AdminTenantDetailPage';
import { AdminTenantsPage } from './pages/admin/AdminTenantsPage';
import { AdminTransmissionsPage } from './pages/admin/AdminTransmissionsPage';
import { PartnerSubTenantsPage } from './pages/partner/PartnerSubTenantsPage';
import { ApprovalsPage } from './pages/merchant/ApprovalsPage';
import { BatchesPage } from './pages/merchant/BatchesPage';
import { DashboardPage } from './pages/merchant/DashboardPage';
import { InvoiceDetailPage } from './pages/merchant/InvoiceDetailPage';
import { InvoicesPage } from './pages/merchant/InvoicesPage';
import { SettingsPage } from './pages/merchant/SettingsPage';
import { StagingPage } from './pages/merchant/StagingPage';
import { UploadPage } from './pages/merchant/UploadPage';
import { can as storeCan, homePathFor, isPartnerUser, isPlatformUser, useAuthStore } from './stores/auth';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Retrying an authorisation or validation failure just delays the
        // message the user needs to see.
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

/**
 * v2.1 has three panels, not two, so the guard asks which one a route belongs
 * to and sends anyone else to their own home. A user who lands on the wrong URL
 * has not done anything wrong, so they get redirected rather than an error.
 */
type Area = 'tenant' | 'platform' | 'partner';

function areaOf(user: ReturnType<typeof useAuthStore.getState>['user']): Area {
  if (isPlatformUser(user)) return 'platform';
  if (isPartnerUser(user)) return 'partner';
  return 'tenant';
}

function RequireAuth({ children, area = 'tenant' }: { children: JSX.Element; area?: Area }) {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.accessToken);

  if (!token || !user) return <Navigate to="/login" replace />;
  if (areaOf(user) !== area) return <Navigate to={homePathFor(user)} replace />;

  return children;
}

/** A tenant route that additionally needs a capability, such as the CFO queue. */
function RequirePermission({
  children,
  permission,
}: {
  children: JSX.Element;
  permission: Parameters<typeof storeCan>[1];
}) {
  const user = useAuthStore((s) => s.user);
  if (!storeCan(user, permission)) return <Navigate to="/" replace />;
  return children;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />

        {/* Merchant */}
        <Route
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route path="/" element={<DashboardPage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/batches" element={<BatchesPage />} />
          <Route path="/batches/:batchId" element={<StagingPage />} />
          <Route path="/invoices" element={<InvoicesPage />} />
          <Route path="/invoices/:invoiceId" element={<InvoiceDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route
            path="/approvals"
            element={
              <RequirePermission permission="invoice.submit">
                <ApprovalsPage />
              </RequirePermission>
            }
          />
        </Route>

        {/* Channel partner */}
        <Route
          element={
            <RequireAuth area="partner">
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route path="/partner/sub-tenants" element={<PartnerSubTenantsPage />} />
        </Route>

        {/* Platform admin */}
        <Route
          element={
            <RequireAuth area="platform">
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route path="/admin/tenants" element={<AdminTenantsPage />} />
          <Route path="/admin/tenants/:tenantId" element={<AdminTenantDetailPage />} />
          <Route path="/admin/transmissions" element={<AdminTransmissionsPage />} />
          <Route path="/admin/audit" element={<AdminAuditPage />} />
          <Route path="/admin/staff" element={<AdminStaffPage />} />
          <Route path="/admin/mail" element={<AdminMailPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </QueryClientProvider>
  );
}
