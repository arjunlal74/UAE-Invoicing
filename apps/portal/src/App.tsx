import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { PasswordRotationGate } from './components/PasswordRotationGate';
import { ApiError } from './lib/api';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { LoginPage } from './pages/LoginPage';
import { SecurityPage } from './pages/SecurityPage';
import { AdminAuditPage } from './pages/admin/AdminAuditPage';
import { AdminInventoryPage } from './pages/admin/AdminInventoryPage';
import { AdminProvidersPage } from './pages/admin/AdminProvidersPage';
import { AdminBuyDataPage } from './pages/admin/AdminBuyDataPage';
import { AdminSellDataPage } from './pages/admin/AdminSellDataPage';
import { AdminBuyDataFormPage } from './pages/admin/AdminBuyDataFormPage';
import { AdminSellDataFormPage } from './pages/admin/AdminSellDataFormPage';
import { AdminInventoryReportPage } from './pages/admin/AdminInventoryReportPage';
import { AdminCompanyPage } from './pages/admin/AdminCompanyPage';
import { PartnerInventoryPage } from './pages/partner/PartnerInventoryPage';
import { InventoryStatementPage } from './pages/settings/InventoryStatementPage';
import { AdminDashboardPage } from './pages/admin/AdminDashboardPage';
import { AdminMailPage } from './pages/admin/AdminMailPage';
import { AdminStaffPage } from './pages/admin/AdminStaffPage';
import { AdminTenantDetailPage } from './pages/admin/AdminTenantDetailPage';
import { AdminTenantsPage } from './pages/admin/AdminTenantsPage';
import { AdminTransmissionsPage } from './pages/admin/AdminTransmissionsPage';
import { PartnerDashboardPage } from './pages/partner/PartnerDashboardPage';
import { PartnerStaffPage } from './pages/partner/PartnerStaffPage';
import { PartnerSubTenantsPage } from './pages/partner/PartnerSubTenantsPage';
import { ApDisputesPage } from './pages/ap/ApDisputesPage';
import { ApOverviewPage } from './pages/ap/ApOverviewPage';
import { ApInboxPage } from './pages/ap/InboxPage';
import { PurchaseDocumentsPage } from './pages/ap/PurchaseDocumentsPage';
import { PurchaseInvoiceDetailPage } from './pages/ap/PurchaseInvoiceDetailPage';
import { SuppliersPage } from './pages/ap/SuppliersPage';
import { CreditNoteBuilderPage } from './pages/ar/CreditNoteBuilderPage';
import { CustomersPage } from './pages/ar/CustomersPage';
import { DisputesPage } from './pages/ar/DisputesPage';
import { DraftsPage } from './pages/ar/DraftsPage';
import { InvoiceBuilderPage } from './pages/ar/InvoiceBuilderPage';
import { AnalyticsPage } from './pages/reports/AnalyticsPage';
import { ReportLibraryPage } from './pages/reports/ReportLibraryPage';
import { ApiKeysPage } from './pages/settings/ApiKeysPage';
import { UsagePage } from './pages/settings/UsagePage';
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
/**
 * 'any' is for screens that belong to the person rather than to a panel —
 * changing your own password is the same act whichever console you work in.
 */
type Area = 'tenant' | 'platform' | 'partner' | 'any';

function areaOf(user: ReturnType<typeof useAuthStore.getState>['user']): Area {
  if (isPlatformUser(user)) return 'platform';
  if (isPartnerUser(user)) return 'partner';
  return 'tenant';
}

function RequireAuth({ children, area = 'tenant' }: { children: JSX.Element; area?: Area }) {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.accessToken);

  if (!token || !user) return <Navigate to="/login" replace />;
  if (user.mustRotatePassword) return <PasswordRotationGate />;
  if (area !== 'any' && areaOf(user) !== area) {
    return <Navigate to={homePathFor(user)} replace />;
  }

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
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />

        {/* Merchant */}
        <Route
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          {/* --- Module 1: Outbound sales (AR) --------------------------- */}
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

          <Route
            path="/ar/new-invoice"
            element={
              <RequirePermission permission="invoice.edit">
                <InvoiceBuilderPage />
              </RequirePermission>
            }
          />
          <Route
            path="/ar/drafts"
            element={
              <RequirePermission permission="invoice.edit">
                <DraftsPage />
              </RequirePermission>
            }
          />
          {/* One builder serves both create and edit; which document it is
              editing comes from the payload, not from a second component. */}
          <Route
            path="/ar/drafts/:draftId"
            element={
              <RequirePermission permission="invoice.edit">
                <InvoiceBuilderPage />
              </RequirePermission>
            }
          />
          <Route
            path="/ar/credit-notes/new"
            element={
              <RequirePermission permission="invoice.edit">
                <CreditNoteBuilderPage />
              </RequirePermission>
            }
          />
          <Route path="/ar/disputes" element={<DisputesPage />} />
          <Route
            path="/ar/customers"
            element={
              <RequirePermission permission="directory.read">
                <CustomersPage />
              </RequirePermission>
            }
          />

          {/* --- Module 2: Inbound purchases (AP) ------------------------ */}
          <Route
            path="/ap"
            element={
              <RequirePermission permission="ap.read">
                <ApOverviewPage />
              </RequirePermission>
            }
          />
          <Route
            path="/ap/inbox"
            element={
              <RequirePermission permission="ap.read">
                <ApInboxPage />
              </RequirePermission>
            }
          />
          <Route
            path="/ap/inbox/:invoiceId"
            element={
              <RequirePermission permission="ap.read">
                <ApInboxPage />
              </RequirePermission>
            }
          />
          <Route
            path="/ap/suppliers"
            element={
              <RequirePermission permission="directory.read">
                <SuppliersPage />
              </RequirePermission>
            }
          />
          <Route
            path="/ap/documents"
            element={
              <RequirePermission permission="ap.read">
                <PurchaseDocumentsPage />
              </RequirePermission>
            }
          />
          <Route
            path="/ap/documents/:invoiceId"
            element={
              <RequirePermission permission="ap.read">
                <PurchaseInvoiceDetailPage />
              </RequirePermission>
            }
          />
          <Route
            path="/ap/disputes"
            element={
              <RequirePermission permission="ap.read">
                <ApDisputesPage />
              </RequirePermission>
            }
          />

          {/* --- Cross-module ------------------------------------------- */}
          <Route
            path="/reports"
            element={
              <RequirePermission permission="reports.read">
                <AnalyticsPage />
              </RequirePermission>
            }
          />
          <Route
            path="/reports/library"
            element={
              <RequirePermission permission="reports.read">
                <ReportLibraryPage />
              </RequirePermission>
            }
          />
          <Route
            path="/settings/usage"
            element={
              <RequirePermission permission="billing.read">
                <UsagePage />
              </RequirePermission>
            }
          />
          <Route
            path="/settings/inventory"
            element={
              <RequirePermission permission="billing.read">
                <InventoryStatementPage />
              </RequirePermission>
            }
          />
          <Route
            path="/settings/api-keys"
            element={
              // Minting a credential that can file tax documents is an identity
              // decision, so it sits behind the permission governing the others.
              <RequirePermission permission="tenant.users.manage">
                <ApiKeysPage />
              </RequirePermission>
            }
          />
        </Route>

        {/* Available to every signed-in role */}
        <Route
          element={
            <RequireAuth area="any">
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route path="/security" element={<SecurityPage />} />
        </Route>

        {/* Channel partner */}
        <Route
          element={
            <RequireAuth area="partner">
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route path="/partner" element={<PartnerDashboardPage />} />
          <Route path="/partner/sub-tenants" element={<PartnerSubTenantsPage />} />
          <Route path="/partner/staff" element={<PartnerStaffPage />} />
          <Route path="/partner/inventory" element={<PartnerInventoryPage />} />
        </Route>

        {/* Platform admin */}
        <Route
          element={
            <RequireAuth area="platform">
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route path="/admin" element={<AdminDashboardPage />} />
          <Route path="/admin/company" element={<AdminCompanyPage />} />
          <Route path="/admin/tenants" element={<AdminTenantsPage />} />
          <Route path="/admin/tenants/:tenantId" element={<AdminTenantDetailPage />} />
          <Route path="/admin/transmissions" element={<AdminTransmissionsPage />} />
          <Route path="/admin/inventory" element={<AdminInventoryPage />} />
          <Route path="/admin/inventory/providers" element={<AdminProvidersPage />} />
          <Route path="/admin/inventory/report" element={<AdminInventoryReportPage />} />
          {/* A partner's ledger, host side. Addressed, so it can be linked to
              from the tier table and sent to the partner it describes. */}
          <Route
            path="/admin/inventory/report/:tenantId"
            element={<AdminInventoryReportPage />}
          />
          {/* The list, and the form it launches. Registering a purchase or a
              sale is a screen of its own rather than a dialog over the list:
              both are forms with money in them. */}
          <Route path="/admin/inventory/buy" element={<AdminBuyDataPage />} />
          <Route path="/admin/inventory/buy/new" element={<AdminBuyDataFormPage />} />
          <Route path="/admin/inventory/sell" element={<AdminSellDataPage />} />
          <Route path="/admin/inventory/sell/new" element={<AdminSellDataFormPage />} />
          {/* The buffer is one field. It stays a dialog over the console it
              governs, addressed so the ribbon can link to it. */}
          <Route path="/admin/inventory/:action" element={<AdminInventoryPage />} />
          <Route path="/admin/audit" element={<AdminAuditPage />} />
          <Route path="/admin/staff" element={<AdminStaffPage />} />
          <Route path="/admin/mail" element={<AdminMailPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </QueryClientProvider>
  );
}
