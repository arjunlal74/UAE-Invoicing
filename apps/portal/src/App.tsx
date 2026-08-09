import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { ApiError } from './lib/api';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { LoginPage } from './pages/LoginPage';
import { AdminAuditPage } from './pages/admin/AdminAuditPage';
import { AdminStaffPage } from './pages/admin/AdminStaffPage';
import { AdminTenantDetailPage } from './pages/admin/AdminTenantDetailPage';
import { AdminTenantsPage } from './pages/admin/AdminTenantsPage';
import { AdminTransmissionsPage } from './pages/admin/AdminTransmissionsPage';
import { BatchesPage } from './pages/merchant/BatchesPage';
import { DashboardPage } from './pages/merchant/DashboardPage';
import { InvoiceDetailPage } from './pages/merchant/InvoiceDetailPage';
import { InvoicesPage } from './pages/merchant/InvoicesPage';
import { SettingsPage } from './pages/merchant/SettingsPage';
import { StagingPage } from './pages/merchant/StagingPage';
import { UploadPage } from './pages/merchant/UploadPage';
import { isPlatformUser, useAuthStore } from './stores/auth';

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

function RequireAuth({ children, platform }: { children: JSX.Element; platform?: boolean }) {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.accessToken);

  if (!token || !user) return <Navigate to="/login" replace />;

  // A merchant reaching an admin URL is sent to their own home rather than
  // shown a permission error — they did not do anything wrong.
  if (platform && !isPlatformUser(user)) return <Navigate to="/" replace />;
  if (!platform && isPlatformUser(user)) return <Navigate to="/admin/tenants" replace />;

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
        </Route>

        {/* Platform admin */}
        <Route
          element={
            <RequireAuth platform>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route path="/admin/tenants" element={<AdminTenantsPage />} />
          <Route path="/admin/tenants/:tenantId" element={<AdminTenantDetailPage />} />
          <Route path="/admin/transmissions" element={<AdminTransmissionsPage />} />
          <Route path="/admin/audit" element={<AdminAuditPage />} />
          <Route path="/admin/staff" element={<AdminStaffPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </QueryClientProvider>
  );
}
