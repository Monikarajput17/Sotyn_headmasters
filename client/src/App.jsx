import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Login from './pages/Login';
// Layout (the authenticated app shell — sidebar, header, CallProvider/WebRTC,
// AI chat, bells, ~64 icons) is lazy so it stays OUT of the entry chunk. A
// logged-out visitor's first paint is just Login; logged-in users fetch this
// chunk in parallel with their lazy page chunk under the <Suspense> below.
const Layout = lazy(() => import('./components/Layout'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Leads = lazy(() => import('./pages/Leads'));
const Quotations = lazy(() => import('./pages/Quotations'));
const Estimator = lazy(() => import('./pages/Estimator'));
const SolarQuotation = lazy(() => import('./pages/SolarQuotation'));
const SolarRateMaster = lazy(() => import('./pages/SolarRateMaster'));
const SolarFunnel = lazy(() => import('./pages/SolarFunnel'));
const SolarMaterialMaster = lazy(() => import('./pages/SolarMaterialMaster'));
const SolarLabourMaster = lazy(() => import('./pages/SolarLabourMaster'));
const SolarProjects = lazy(() => import('./pages/SolarProjects'));
const PoFocStripped = lazy(() => import('./pages/PoFocStripped'));
const PoFocPrint = lazy(() => import('./pages/PoFocPrint'));
const LabourRate = lazy(() => import('./pages/LabourRate'));
const Orders = lazy(() => import('./pages/Orders'));
const BusinessBook = lazy(() => import('./pages/BusinessBook'));
const ItemMaster = lazy(() => import('./pages/ItemMaster'));
const PaymentRequired = lazy(() => import('./pages/PaymentRequired'));
const Attendance = lazy(() => import('./pages/Attendance'));
const Vendors = lazy(() => import('./pages/Vendors'));
const Customers = lazy(() => import('./pages/Customers'));
const Procurement = lazy(() => import('./pages/Procurement'));
const PriceRequired = lazy(() => import('./pages/PriceRequired'));
const Installation = lazy(() => import('./pages/Installation'));
const SalesBilling = lazy(() => import('./pages/SalesBilling'));
const Billing = lazy(() => import('./pages/Billing'));
const Complaints = lazy(() => import('./pages/Complaints'));
const HR = lazy(() => import('./pages/HR'));
const Payroll = lazy(() => import('./pages/Payroll'));
const SalarySlipPrint = lazy(() => import('./pages/SalarySlipPrint'));
const Scorecard = lazy(() => import('./pages/Scorecard'));
const Champions = lazy(() => import('./pages/Champions'));
const ModuleOwners = lazy(() => import('./pages/ModuleOwners'));
const Tools = lazy(() => import('./pages/Tools'));
const Rentals = lazy(() => import('./pages/Rentals'));
const Snags = lazy(() => import('./pages/Snags'));
const CompanyAssets = lazy(() => import('./pages/CompanyAssets'));
const Employees = lazy(() => import('./pages/Employees'));
const Expenses = lazy(() => import('./pages/Expenses'));
const Checklists = lazy(() => import('./pages/Checklists'));
const CashFlow = lazy(() => import('./pages/CashFlow'));
const Collections = lazy(() => import('./pages/Collections'));
const ArApTracker = lazy(() => import('./pages/ArApTracker'));
const SiteChat = lazy(() => import('./pages/SiteChat'));
const IndentFMS = lazy(() => import('./pages/IndentFMS'));
const DPR = lazy(() => import('./pages/DPR'));
const IndentLabourPayment = lazy(() => import('./pages/IndentLabourPayment'));
const Delegation = lazy(() => import('./pages/Delegation'));
const PMSTasks = lazy(() => import('./pages/PMSTasks'));
const Inventory = lazy(() => import('./pages/Inventory'));
const HelpTickets = lazy(() => import('./pages/HelpTickets'));
const VendorPOPrint = lazy(() => import('./pages/VendorPOPrint'));
const DebitNotePrint = lazy(() => import('./pages/DebitNotePrint'));
const PaymentAdvicePrint = lazy(() => import('./pages/PaymentAdvicePrint'));
const DeliveryNotePrint = lazy(() => import('./pages/DeliveryNotePrint'));
const RentalPOPrint = lazy(() => import('./pages/RentalPOPrint'));
const IndentPrint = lazy(() => import('./pages/IndentPrint'));
const QuotationPrint = lazy(() => import('./pages/QuotationPrint'));
const UserManagement = lazy(() => import('./pages/admin/UserManagement'));
const RolesPermissions = lazy(() => import('./pages/admin/RolesPermissions'));
const DatabaseBackups = lazy(() => import('./pages/admin/DatabaseBackups'));
const AuditLog = lazy(() => import('./pages/admin/AuditLog'));
const WordCount = lazy(() => import('./pages/admin/WordCount'));
const Locations = lazy(() => import('./pages/admin/Locations'));
const CollectionsMD = lazy(() => import('./pages/admin/CollectionsMD'));
const AISettings = lazy(() => import('./pages/AISettings'));
const SubContractors = lazy(() => import('./pages/SubContractors'));
const SubconHiring = lazy(() => import('./pages/SubconHiring'));
const ProcurementSchedule = lazy(() => import('./pages/ProcurementSchedule'));
const CRMFunnel = lazy(() => import('./pages/CRMFunnel'));
const ChequeFMS = lazy(() => import('./pages/ChequeFMS'));
const EmailSettings = lazy(() => import('./pages/EmailSettings'));
const EmailTriggers = lazy(() => import('./pages/EmailTriggers'));
const DashboardCMD = lazy(() => import('./pages/DashboardCMD'));
const DashboardCMDToc = lazy(() => import('./pages/DashboardCMDToc'));
const DashboardWarRoom = lazy(() => import('./pages/DashboardWarRoom'));
const FireNoc = lazy(() => import('./pages/FireNoc'));
const RentalTools = lazy(() => import('./pages/RentalTools'));
const Influencers = lazy(() => import('./pages/Influencers'));
const CRMKitting = lazy(() => import('./pages/CRMKitting'));
const HRSystem = lazy(() => import('./pages/HRSystem'));
const OfferLetterPrint = lazy(() => import('./pages/OfferLetterPrint'));
const NDAPrint = lazy(() => import('./pages/NDAPrint'));
const EmploymentAgreementPrint = lazy(() => import('./pages/EmploymentAgreementPrint'));
const PublicOffer = lazy(() => import('./pages/PublicOffer'));
const Induction = lazy(() => import('./pages/Induction'));
const Training = lazy(() => import('./pages/Training'));
// ─── Sotyn.Headmasters fork — salon & spa pages ───────────────────────────
const SalonDashboard = lazy(() => import('./pages/SalonDashboard'));
const SalonServices = lazy(() => import('./pages/SalonServices'));
const SalonStylists = lazy(() => import('./pages/SalonStylists'));
const SalonClients = lazy(() => import('./pages/SalonClients'));
const SalonAppointments = lazy(() => import('./pages/SalonAppointments'));
const SalonMemberships = lazy(() => import('./pages/SalonMemberships'));
const SalonPOS = lazy(() => import('./pages/SalonPOS'));
const SalonCommissions = lazy(() => import('./pages/SalonCommissions'));
const SalonProducts = lazy(() => import('./pages/SalonProducts'));
const PublicBooking = lazy(() => import('./pages/PublicBooking'));

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen">Loading...</div>;
  return user ? children : <Navigate to="/login" />;
}

function AdminRoute({ children }) {
  const { isAdmin, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen">Loading...</div>;
  return isAdmin() ? children : <Navigate to="/" />;
}

function ModuleRoute({ module, children }) {
  const { canView, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen">Loading...</div>;
  if (!canView(module)) return (
    <div className="flex flex-col items-center justify-center h-96 text-gray-400">
      <svg className="w-16 h-16 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
      <h3 className="text-lg font-medium text-gray-500">Access Denied</h3>
      <p className="text-sm mt-1">You don't have permission to access this module. Contact your admin.</p>
    </div>
  );
  return children;
}

export default function App() {
  const { user, loading } = useAuth();

  if (loading) return <div className="flex items-center justify-center h-screen text-lg">Loading...</div>;

  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen text-lg text-gray-400">Loading…</div>}>
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" /> : <Login />} />
      {/* Print routes — auth-gated but rendered WITHOUT the sidebar / header
          chrome so the document fills the viewport cleanly. */}
      <Route path="/vendor-po/:id/print" element={<ProtectedRoute><VendorPOPrint /></ProtectedRoute>} />
      <Route path="/debit-note/:id/print" element={<ProtectedRoute><DebitNotePrint /></ProtectedRoute>} />
      <Route path="/payment-advice/print" element={<ProtectedRoute><PaymentAdvicePrint /></ProtectedRoute>} />
      {/* Mam (2026-05-22): "delivery note make here automatically and
          show pdf here according to po" — print-on-demand DN auto-
          filled from the same Vendor PO data.  No delivery_notes
          row needed. */}
      <Route path="/vendor-po/:id/delivery-note" element={<ProtectedRoute><DeliveryNotePrint /></ProtectedRoute>} />
      <Route path="/rental-po/:id/print" element={<ProtectedRoute><RentalPOPrint /></ProtectedRoute>} />
      <Route path="/indent/:id/print" element={<ProtectedRoute><IndentPrint /></ProtectedRoute>} />
      <Route path="/quotation/:indentId/print" element={<ProtectedRoute><QuotationPrint /></ProtectedRoute>} />
      <Route path="/po-foc/:id/print" element={<ProtectedRoute><PoFocPrint /></ProtectedRoute>} />
      <Route path="/payroll/slip/:employee_id" element={<ProtectedRoute><SalarySlipPrint /></ProtectedRoute>} />
      <Route path="/hr/candidates/:id/offer-letter" element={<ProtectedRoute><OfferLetterPrint /></ProtectedRoute>} />
      <Route path="/hr/candidates/:id/nda" element={<ProtectedRoute><NDAPrint /></ProtectedRoute>} />
      <Route path="/hr/candidates/:id/employment-agreement" element={<ProtectedRoute><EmploymentAgreementPrint /></ProtectedRoute>} />
      {/* Mam (2026-05-22 Batch D): public offer-accept page — NO
          ProtectedRoute wrapper.  Candidate uses the token in the
          URL as the identity; no SEPL login required. */}
      <Route path="/offer/:token" element={<PublicOffer />} />
      {/* Public online booking — no login required (share this link with clients) */}
      <Route path="/book" element={<PublicBooking />} />
      <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<SalonDashboard />} />
        {/* ─── Sotyn.Headmasters fork — salon & spa routes ─── */}
        <Route path="salon/services" element={<ModuleRoute module="salon_services"><SalonServices /></ModuleRoute>} />
        <Route path="salon/stylists" element={<ModuleRoute module="salon_stylists"><SalonStylists /></ModuleRoute>} />
        <Route path="salon/clients" element={<ModuleRoute module="salon_clients"><SalonClients /></ModuleRoute>} />
        <Route path="salon/appointments" element={<ModuleRoute module="salon_appointments"><SalonAppointments /></ModuleRoute>} />
        <Route path="salon/memberships" element={<ModuleRoute module="salon_memberships"><SalonMemberships /></ModuleRoute>} />
        <Route path="salon/billing" element={<ModuleRoute module="salon_pos"><SalonPOS /></ModuleRoute>} />
        <Route path="salon/products" element={<ModuleRoute module="salon_products"><SalonProducts /></ModuleRoute>} />
        <Route path="salon/commissions" element={<ModuleRoute module="salon_commissions"><SalonCommissions /></ModuleRoute>} />
        {/* TOC v3 role dashboards — admin-only for now, dark-navy CMD
            style.  COO / Sales / Finance variants will land as their
            HTML specs come in from MD. */}
        <Route path="dashboard/cmd" element={<AdminRoute><DashboardCMD /></AdminRoute>} />
        <Route path="dashboard/cmd-toc" element={<AdminRoute><DashboardCMDToc /></AdminRoute>} />
        <Route path="dashboard/war-room" element={<AdminRoute><DashboardWarRoom /></AdminRoute>} />
        <Route path="fire-noc" element={<ModuleRoute module="fire_noc"><FireNoc /></ModuleRoute>} />
        <Route path="rental-tools" element={<ModuleRoute module="rental_tools"><RentalTools /></ModuleRoute>} />
        <Route path="influencers" element={<ModuleRoute module="influencers"><Influencers /></ModuleRoute>} />
        <Route path="crm-kitting" element={<ModuleRoute module="crm_kitting"><CRMKitting /></ModuleRoute>} />
        <Route path="hr-system" element={<ModuleRoute module="hr_system"><HRSystem /></ModuleRoute>} />
        {/* Mam (2026-05-22 Batch E): Induction + Training are open
            to ALL employees — no module gate so even read-only users
            can complete their training. */}
        <Route path="induction" element={<Induction />} />
        <Route path="training" element={<Training />} />
        {/* 4 Critical Systems */}
        <Route path="cashflow" element={<ModuleRoute module="cashflow"><CashFlow /></ModuleRoute>} />
        <Route path="payment-required" element={<ModuleRoute module="payment_required"><PaymentRequired /></ModuleRoute>} />
        <Route path="attendance" element={<ModuleRoute module="attendance"><Attendance /></ModuleRoute>} />
        <Route path="collections" element={<ModuleRoute module="collections"><Collections /></ModuleRoute>} />
        <Route path="ar-ap-tracker" element={<ModuleRoute module="ar_ap_tracker"><ArApTracker /></ModuleRoute>} />
        {/* WhatsApp is open to all signed-in users — access is by group
            membership, not the site_chat module permission (mam 2026-06-19). */}
        <Route path="site-chat" element={<SiteChat />} />
        <Route path="indent-fms" element={<ModuleRoute module="indent_fms"><IndentFMS /></ModuleRoute>} />
        <Route path="dpr" element={<ModuleRoute module="dpr"><DPR /></ModuleRoute>} />
        {/* Mam (2026-06-01) — Project Execution & Billing pipeline. */}
        <Route path="indent-labour-payment" element={<ModuleRoute module="indent_labour_payment"><IndentLabourPayment /></ModuleRoute>} />
        <Route path="delegations" element={<ModuleRoute module="delegations"><Delegation /></ModuleRoute>} />
        <Route path="pms-tasks" element={<ModuleRoute module="pms_tasks"><PMSTasks /></ModuleRoute>} />
        {/* Other Modules */}
        <Route path="leads" element={<ModuleRoute module="leads"><Leads /></ModuleRoute>} />
        <Route path="quotations" element={<ModuleRoute module="quotations"><Quotations /></ModuleRoute>} />
        <Route path="estimator" element={<ModuleRoute module="ai_quotation"><Estimator /></ModuleRoute>} />
        <Route path="solar-funnel" element={<ModuleRoute module="solar_quotation"><SolarFunnel /></ModuleRoute>} />
        <Route path="solar-quotation" element={<ModuleRoute module="solar_quotation"><SolarQuotation /></ModuleRoute>} />
        <Route path="solar-projects" element={<ModuleRoute module="solar_quotation"><SolarProjects /></ModuleRoute>} />
        <Route path="solar-material-master" element={<ModuleRoute module="solar_quotation"><SolarMaterialMaster /></ModuleRoute>} />
        <Route path="solar-labour-master" element={<ModuleRoute module="solar_quotation"><SolarLabourMaster /></ModuleRoute>} />
        <Route path="solar-rate-master" element={<ModuleRoute module="solar_quotation"><SolarRateMaster /></ModuleRoute>} />
        <Route path="po-foc-stripped" element={<ModuleRoute module="quotations"><PoFocStripped /></ModuleRoute>} />
        <Route path="labour-rate" element={<ModuleRoute module="labour_rates"><LabourRate /></ModuleRoute>} />
        <Route path="business-book" element={<ModuleRoute module="business_book"><BusinessBook /></ModuleRoute>} />
        <Route path="item-master" element={<ModuleRoute module="item_master"><ItemMaster /></ModuleRoute>} />
        <Route path="orders" element={<ModuleRoute module="orders"><Orders /></ModuleRoute>} />
        <Route path="vendors" element={<ModuleRoute module="vendors"><Vendors /></ModuleRoute>} />
        <Route path="customers" element={<ModuleRoute module="customers"><Customers /></ModuleRoute>} />
        <Route path="procurement" element={<ModuleRoute module="procurement"><Procurement /></ModuleRoute>} />
        <Route path="price-required" element={<PriceRequired />} />
        <Route path="inventory" element={<ModuleRoute module="inventory"><Inventory /></ModuleRoute>} />
        <Route path="help-tickets" element={<HelpTickets />} />
        <Route path="installation" element={<ModuleRoute module="installation"><SalesBilling /></ModuleRoute>} />
        <Route path="billing" element={<ModuleRoute module="billing"><Billing /></ModuleRoute>} />
        <Route path="complaints" element={<ModuleRoute module="complaints"><Complaints /></ModuleRoute>} />
        <Route path="snags" element={<ModuleRoute module="snags"><Snags /></ModuleRoute>} />
        <Route path="company-assets" element={<ModuleRoute module="company_assets"><CompanyAssets /></ModuleRoute>} />
        <Route path="hr" element={<ModuleRoute module="hr"><HR /></ModuleRoute>} />
        <Route path="payroll" element={<ModuleRoute module="payroll"><Payroll /></ModuleRoute>} />
        <Route path="scorecard" element={<ModuleRoute module="scoring"><Scorecard /></ModuleRoute>} />
        <Route path="champions" element={<ModuleRoute module="gamification"><Champions /></ModuleRoute>} />
        <Route path="module-owners" element={<ModuleRoute module="scoring"><ModuleOwners /></ModuleRoute>} />
        {/* Legacy /weekly-score URL → redirect to Scorecard's Team Overview tab.
            Kept so any bookmarked links / push notification deep-links don't 404. */}
        <Route path="weekly-score" element={<Navigate to="/scorecard" replace />} />
        <Route path="tools" element={<ModuleRoute module="tools"><Tools /></ModuleRoute>} />
        <Route path="rentals" element={<ModuleRoute module="rentals"><Rentals /></ModuleRoute>} />
        <Route path="employees" element={<ModuleRoute module="employees"><Employees /></ModuleRoute>} />
        <Route path="expenses" element={<ModuleRoute module="expenses"><Expenses /></ModuleRoute>} />
        <Route path="checklists" element={<ModuleRoute module="checklists"><Checklists /></ModuleRoute>} />
        {/* Admin Routes */}
        <Route path="admin/users" element={<AdminRoute><UserManagement /></AdminRoute>} />
        <Route path="admin/roles" element={<AdminRoute><RolesPermissions /></AdminRoute>} />
        <Route path="admin/backups" element={<AdminRoute><DatabaseBackups /></AdminRoute>} />
        <Route path="admin/audit" element={<AdminRoute><AuditLog /></AdminRoute>} />
        <Route path="admin/word-count" element={<AdminRoute><WordCount /></AdminRoute>} />
        <Route path="admin/locations" element={<AdminRoute><Locations /></AdminRoute>} />
        <Route path="admin/collections-md" element={<AdminRoute><CollectionsMD /></AdminRoute>} />
        <Route path="admin/ai-settings" element={<AdminRoute><AISettings /></AdminRoute>} />
        <Route path="admin/email-settings" element={<AdminRoute><EmailSettings /></AdminRoute>} />
        <Route path="admin/email-triggers" element={<AdminRoute><EmailTriggers /></AdminRoute>} />
        <Route path="sub-contractors" element={<ModuleRoute module="sub_contractors"><SubContractors /></ModuleRoute>} />
        <Route path="subcon-hiring" element={<ModuleRoute module="subcon_hiring"><SubconHiring /></ModuleRoute>} />
        <Route path="procurement-schedule" element={<ModuleRoute module="procurement_schedule"><ProcurementSchedule /></ModuleRoute>} />
        <Route path="crm-funnel" element={<ModuleRoute module="crm_funnel"><CRMFunnel /></ModuleRoute>} />
        <Route path="cheques" element={<ModuleRoute module="cheques"><ChequeFMS /></ModuleRoute>} />
      </Route>
    </Routes>
    </Suspense>
  );
}
