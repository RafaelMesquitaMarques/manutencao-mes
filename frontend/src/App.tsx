import { useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { useAuthStore } from './store/authStore';
import { usePlantStore } from './store/plantStore';
import { fetchMyPermissions, fetchMyPlants, getMe } from './api/auth';
import ProtectedRoute from './pages/ProtectedRoute';
import RequireView from './pages/RequireView';
import Layout from './components/Layout/Layout';

// Every page is lazy-loaded: the initial bundle stays small and heavy vendors
// (three.js, echarts, ag-grid, fullcalendar…) download only when a page that
// uses them is first visited (see manualChunks in vite.config.ts).
const Login = lazy(() => import('./pages/Login'));
const HomePage = lazy(() => import('./pages/Home/HomePage'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const WorkOrderList = lazy(() => import('./pages/WorkOrders/WorkOrderList'));
const WorkOrderDetail = lazy(() => import('./pages/WorkOrders/WorkOrderDetail'));
const NewWorkOrder = lazy(() => import('./pages/WorkOrders/NewWorkOrder'));
const TechnicianList = lazy(() => import('./pages/Technicians/TechnicianList'));
const NewTechnician = lazy(() => import('./pages/Technicians/NewTechnician'));
const TechnicianDetail = lazy(() => import('./pages/Technicians/TechnicianDetail'));
const KPIDashboard = lazy(() => import('./pages/KPIs/KPIDashboard'));
const MachineReport = lazy(() => import('./pages/KPIs/MachineReport'));
const CostsDashboard = lazy(() => import('./pages/Costs/CostsDashboard'));
const JobOrderList = lazy(() => import('./pages/JobOrders/JobOrderList'));
const JobOrderDetail = lazy(() => import('./pages/JobOrders/JobOrderDetail'));
const GestionBT = lazy(() => import('./pages/GestionBT/GestionBT'));
const IntelligenceDashboard = lazy(() => import('./pages/Intelligence/IntelligenceDashboard'));
const EquipmentList = lazy(() => import('./pages/Equipment/EquipmentList'));
const EquipmentDetail = lazy(() => import('./pages/Equipment/EquipmentDetail'));
const NewEquipment = lazy(() => import('./pages/Equipment/NewEquipment'));
const PMCalendar = lazy(() => import('./pages/PMCalendar/PMCalendar'));
const PlanList = lazy(() => import('./pages/MaintenancePlans/PlanList'));
const NewPlan = lazy(() => import('./pages/MaintenancePlans/NewPlan'));
const PlanDetail = lazy(() => import('./pages/MaintenancePlans/PlanDetail'));
const LaborScheduler = lazy(() => import('./pages/Schedule/LaborScheduler'));
const NewAlert = lazy(() => import('./pages/Alerts/NewAlert'));
const AlertDetail = lazy(() => import('./pages/Alerts/AlertDetail'));
const TicketList = lazy(() => import('./pages/Tickets/TicketList'));
const TicketDetail = lazy(() => import('./pages/Tickets/TicketDetail'));
const NewTicket = lazy(() => import('./pages/Tickets/NewTicket'));
const InventoryList = lazy(() => import('./pages/Inventory/InventoryList'));
const InventoryDetail = lazy(() => import('./pages/Inventory/InventoryDetail'));
const NewInventoryItem = lazy(() => import('./pages/Inventory/NewInventoryItem'));
const SupplierList = lazy(() => import('./pages/Suppliers/SupplierList'));
const SupplierDetail = lazy(() => import('./pages/Suppliers/SupplierDetail'));
const NewSupplier = lazy(() => import('./pages/Suppliers/NewSupplier'));
const PurchaseOrderList = lazy(() => import('./pages/PurchaseOrders/PurchaseOrderList'));
const NewPurchaseOrder = lazy(() => import('./pages/PurchaseOrders/NewPurchaseOrder'));
const MaintenanceDashboard = lazy(() => import('./pages/MaintenanceDashboard/MaintenanceDashboard'));
const MachinePage = lazy(() => import('./pages/Machines/MachinePage'));
const FactoryMap = lazy(() => import('./pages/FactoryMap/FactoryMap'));
const DashboardList = lazy(() => import('./pages/Dashboards/DashboardList'));
const DashboardPage = lazy(() => import('./pages/Dashboards/DashboardPage'));
const MyWorkPage = lazy(() => import('./pages/MyWork/MyWorkPage'));
const UsersSetup = lazy(() => import('./pages/Settings/UsersSetup'));
const EscalationSettingsPage = lazy(() => import('./pages/Settings/EscalationSettings'));
const FactoryCalendarPage = lazy(() => import('./pages/Settings/FactoryCalendar'));
const DeviceSettingsPage = lazy(() => import('./pages/Settings/DeviceSettings'));
const LineObjectivesPage = lazy(() => import('./pages/Settings/LineObjectives'));
const DepartmentSettings = lazy(() => import('./pages/Settings/Departments'));
const ShiftSettings = lazy(() => import('./pages/Settings/ShiftSettings'));
const UserDetail = lazy(() => import('./pages/Settings/UserDetail'));
const MyProfile = lazy(() => import('./pages/Settings/MyProfile'));
const ChangePassword = lazy(() => import('./pages/Settings/ChangePassword'));
const ForcedChangePassword = lazy(() => import('./pages/Settings/ForcedChangePassword'));
const AcceptInvite = lazy(() => import('./pages/AcceptInvite'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const WOApproval = lazy(() => import('./pages/Supervisor/WOApproval'));

// Route-level loading state while a lazy page chunk downloads.
function PageFallback() {
  return (
    <div className="h-full min-h-[40vh] flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

// Old standalone intervention URL → unified kiosk (machine ref resolves by id or slug).
function MachineIdRedirect() {
  const { machine_id } = useParams<{ machine_id: string }>();
  return <Navigate to={`/machines/${machine_id}`} replace />;
}

const App = () => {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setPermissions = useAuthStore((s) => s.setPermissions);
  // Load the user's effective permissions once authenticated (refreshes on login).
  useEffect(() => {
    if (isAuthenticated) fetchMyPermissions().then(setPermissions).catch(() => {});
  }, [isAuthenticated, setPermissions]);
  // Refresh plant memberships whenever authenticated — always, not only when the
  // store is empty. A persisted store can be stale (a plant added/renamed, or
  // access granted/revoked since last login); setMemberships keeps the active
  // plant if still valid, so this self-heals without forcing a re-login.
  useEffect(() => {
    if (!isAuthenticated) return;
    fetchMyPlants()
      .then(({ plants, default_plant_id }) =>
        usePlantStore.getState().setMemberships(plants, default_plant_id))
      .catch(() => {});
  }, [isAuthenticated]);
  // Refresh the profile too: admin-side edits (nickname, name, role…) reach the
  // persisted store without forcing a re-login.
  useEffect(() => {
    if (!isAuthenticated) return;
    getMe()
      .then((me) => useAuthStore.getState().patchUser(me))
      .catch(() => {});
  }, [isAuthenticated]);

  return (
  <BrowserRouter>
    <Suspense fallback={<PageFallback />}>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/force-change-password"
        element={
          <ProtectedRoute>
            <ForcedChangePassword />
          </ProtectedRoute>
        }
      />
      <Route path="/machines/:slug" element={<MachinePage />} />
      {/* Unified kiosk: the old standalone intervention page now redirects into MachinePage
          (which embeds the mechanic flow). A machine ref resolves by id OR slug server-side. */}
      <Route path="/machine/:machine_id" element={<MachineIdRedirect />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        {/* Home is the post-login landing — a personalized welcome page every
            authenticated user can see (no permission gate). */}
        <Route index element={<Navigate to="/home" replace />} />
        <Route path="home"                  element={<HomePage />} />
        <Route path="dashboard"             element={<Dashboard />} />
        <Route path="work-orders"           element={<RequireView resource="work_orders"><WorkOrderList /></RequireView>} />
        <Route path="work-orders/new"       element={<NewWorkOrder />} />
        <Route path="work-orders/:id"       element={<WorkOrderDetail />} />
        <Route path="technicians"           element={<RequireView resource="technicians"><TechnicianList /></RequireView>} />
        <Route path="technicians/new"       element={<NewTechnician />} />
        <Route path="technicians/:id"       element={<TechnicianDetail />} />
        <Route path="kpis"                  element={<RequireView resource="kpis"><KPIDashboard /></RequireView>} />
        <Route path="kpis/machines"         element={<RequireView resource="machine_reports"><MachineReport /></RequireView>} />
        <Route path="costs"                 element={<RequireView resource="costs"><CostsDashboard /></RequireView>} />
        <Route path="job-orders"            element={<RequireView resource="job_orders"><JobOrderList /></RequireView>} />
        <Route path="job-orders/:id"        element={<RequireView resource="job_orders"><JobOrderDetail /></RequireView>} />
        <Route path="intelligence"          element={<RequireView resource="intelligence"><IntelligenceDashboard /></RequireView>} />
        <Route path="equipment"             element={<RequireView resource="equipment"><EquipmentList /></RequireView>} />
        <Route path="equipment/new"         element={<NewEquipment />} />
        <Route path="equipment/:id"         element={<EquipmentDetail />} />
        <Route path="pm-calendar"           element={<RequireView resource="pm_calendar"><PMCalendar /></RequireView>} />
        <Route path="maintenance/plans"      element={<RequireView resource="maintenance_plans"><PlanList /></RequireView>} />
        <Route path="maintenance/plans/new"  element={<NewPlan />} />
        <Route path="maintenance/plans/:id"  element={<PlanDetail />} />
        <Route path="schedule"              element={<RequireView resource="schedule"><LaborScheduler /></RequireView>} />
        <Route path="gestion-bt"           element={<RequireView resource="alerts"><GestionBT /></RequireView>} />
        {/* legacy paths — Alerts and Supervisor View were merged into Gestion BT */}
        <Route path="alerts"               element={<Navigate to="/gestion-bt" replace />} />
        <Route path="alerts/new"            element={<NewAlert />} />
        <Route path="alerts/:id"            element={<AlertDetail />} />
        <Route path="tickets"              element={<RequireView resource="tickets"><TicketList /></RequireView>} />
        <Route path="tickets/new"          element={<NewTicket />} />
        <Route path="tickets/:id"          element={<TicketDetail />} />
        <Route path="inventory"            element={<RequireView resource="inventory"><InventoryList /></RequireView>} />
        <Route path="inventory/new"        element={<NewInventoryItem />} />
        <Route path="inventory/:id"        element={<InventoryDetail />} />
        <Route path="suppliers"            element={<RequireView resource="suppliers"><SupplierList /></RequireView>} />
        <Route path="suppliers/new"        element={<NewSupplier />} />
        <Route path="suppliers/:id"        element={<SupplierDetail />} />
        <Route path="supplier-orders"      element={<RequireView resource="purchase_orders"><PurchaseOrderList /></RequireView>} />
        <Route path="supplier-orders/new"  element={<NewPurchaseOrder />} />
        <Route path="maintenance/dashboard"      element={<RequireView resource="maintenance"><MaintenanceDashboard /></RequireView>} />
        <Route path="maintenance/supervisor"     element={<Navigate to="/gestion-bt?tab=bt" replace />} />
        <Route path="factory-map"                element={<RequireView resource="factory_map"><FactoryMap /></RequireView>} />
        <Route path="dashboards"                 element={<RequireView resource="dashboards"><DashboardList /></RequireView>} />
        <Route path="dashboards/:slug"           element={<RequireView resource="dashboards"><DashboardPage /></RequireView>} />
        <Route path="maintenance/wo-approval" element={<RequireView resource="wo_approval"><WOApproval /></RequireView>} />
        {/* legacy path → keep old links working */}
        <Route path="maintenance/parts-approval" element={<RequireView resource="wo_approval"><WOApproval /></RequireView>} />
        <Route path="machines"              element={<Navigate to="/equipment" replace />} />
        <Route path="my-work"               element={<MyWorkPage />} />
        <Route path="settings/machines"           element={<Navigate to="/equipment" replace />} />
        <Route path="settings/machines/:id"       element={<Navigate to="/equipment" replace />} />
        <Route path="settings/stop-categories"    element={<Navigate to="/equipment" replace />} />
        <Route path="settings/escalation"         element={<RequireView resource="settings_escalation"><EscalationSettingsPage /></RequireView>} />
        <Route path="settings/calendar"           element={<RequireView resource="calendar"><FactoryCalendarPage /></RequireView>} />
        <Route path="settings/devices"            element={<RequireView resource="settings_devices"><DeviceSettingsPage /></RequireView>} />
        <Route path="settings/line-objectives"    element={<RequireView resource="settings_machines"><LineObjectivesPage /></RequireView>} />
        <Route path="settings/departments"        element={<RequireView resource="settings_departments"><DepartmentSettings /></RequireView>} />
        <Route path="settings/shifts"             element={<RequireView resource="technicians"><ShiftSettings /></RequireView>} />
        <Route path="settings/users"              element={<UsersSetup />} />
        <Route path="settings/users/:id"          element={<UserDetail />} />
        <Route path="settings/profile"            element={<MyProfile />} />
        <Route path="settings/change-password"    element={<ChangePassword />} />
        <Route path="settings/intervention-types" element={<Navigate to="/equipment" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/home" replace />} />
    </Routes>
    </Suspense>
  </BrowserRouter>
  );
};

export default App;
