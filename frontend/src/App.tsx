import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { useAuthStore } from './store/authStore';
import { fetchMyPermissions } from './api/auth';
import ProtectedRoute from './pages/ProtectedRoute';
import RequireView from './pages/RequireView';
import Layout from './components/Layout/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import WorkOrderList from './pages/WorkOrders/WorkOrderList';
import WorkOrderDetail from './pages/WorkOrders/WorkOrderDetail';
import NewWorkOrder from './pages/WorkOrders/NewWorkOrder';
import TechnicianList from './pages/Technicians/TechnicianList';
import NewTechnician from './pages/Technicians/NewTechnician';
import TechnicianDetail from './pages/Technicians/TechnicianDetail';
import KPIDashboard from './pages/KPIs/KPIDashboard';
import MachineReport from './pages/KPIs/MachineReport';
import IntelligenceDashboard from './pages/Intelligence/IntelligenceDashboard';
import EquipmentList from './pages/Equipment/EquipmentList';
import EquipmentDetail from './pages/Equipment/EquipmentDetail';
import NewEquipment from './pages/Equipment/NewEquipment';
import PMCalendar from './pages/PMCalendar/PMCalendar';
import PlanList from './pages/MaintenancePlans/PlanList';
import NewPlan from './pages/MaintenancePlans/NewPlan';
import PlanDetail from './pages/MaintenancePlans/PlanDetail';
import LaborScheduler from './pages/Schedule/LaborScheduler';
import AlertList from './pages/Alerts/AlertList';
import NewAlert from './pages/Alerts/NewAlert';
import AlertDetail from './pages/Alerts/AlertDetail';
import TicketList from './pages/Tickets/TicketList';
import TicketDetail from './pages/Tickets/TicketDetail';
import NewTicket from './pages/Tickets/NewTicket';
import InventoryList    from './pages/Inventory/InventoryList';
import InventoryDetail  from './pages/Inventory/InventoryDetail';
import NewInventoryItem from './pages/Inventory/NewInventoryItem';
import SupplierList     from './pages/Suppliers/SupplierList';
import SupplierDetail   from './pages/Suppliers/SupplierDetail';
import NewSupplier      from './pages/Suppliers/NewSupplier';
import PurchaseOrderList from './pages/PurchaseOrders/PurchaseOrderList';
import NewPurchaseOrder  from './pages/PurchaseOrders/NewPurchaseOrder';
import MaintenanceDashboard from './pages/MaintenanceDashboard/MaintenanceDashboard';
import SupervisorDashboard from './pages/MaintenanceDashboard/SupervisorDashboard';
import MachinePage from './pages/Machines/MachinePage';
import FactoryMap from './pages/FactoryMap/FactoryMap';
import MyWorkPage from './pages/MyWork/MyWorkPage';
import UsersSetup from './pages/Settings/UsersSetup';
import EscalationSettingsPage from './pages/Settings/EscalationSettings';
import UserDetail from './pages/Settings/UserDetail';
import MyProfile from './pages/Settings/MyProfile';
import ChangePassword from './pages/Settings/ChangePassword';
import ForcedChangePassword from './pages/Settings/ForcedChangePassword';
import AcceptInvite from './pages/AcceptInvite';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import WOApproval from './pages/Supervisor/WOApproval';

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

  return (
  <BrowserRouter>
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
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard"             element={<Dashboard />} />
        <Route path="work-orders"           element={<RequireView resource="work_orders"><WorkOrderList /></RequireView>} />
        <Route path="work-orders/new"       element={<NewWorkOrder />} />
        <Route path="work-orders/:id"       element={<WorkOrderDetail />} />
        <Route path="technicians"           element={<RequireView resource="technicians"><TechnicianList /></RequireView>} />
        <Route path="technicians/new"       element={<NewTechnician />} />
        <Route path="technicians/:id"       element={<TechnicianDetail />} />
        <Route path="kpis"                  element={<RequireView resource="kpis"><KPIDashboard /></RequireView>} />
        <Route path="kpis/machines"         element={<RequireView resource="kpis"><MachineReport /></RequireView>} />
        <Route path="intelligence"          element={<IntelligenceDashboard />} />
        <Route path="equipment"             element={<RequireView resource="equipment"><EquipmentList /></RequireView>} />
        <Route path="equipment/new"         element={<NewEquipment />} />
        <Route path="equipment/:id"         element={<EquipmentDetail />} />
        <Route path="pm-calendar"           element={<RequireView resource="pm_calendar"><PMCalendar /></RequireView>} />
        <Route path="maintenance/plans"      element={<RequireView resource="pm_calendar"><PlanList /></RequireView>} />
        <Route path="maintenance/plans/new"  element={<NewPlan />} />
        <Route path="maintenance/plans/:id"  element={<PlanDetail />} />
        <Route path="schedule"              element={<RequireView resource="schedule"><LaborScheduler /></RequireView>} />
        <Route path="alerts"               element={<RequireView resource="alerts"><AlertList /></RequireView>} />
        <Route path="alerts/new"            element={<NewAlert />} />
        <Route path="alerts/:id"            element={<AlertDetail />} />
        <Route path="tickets"              element={<RequireView resource="tickets"><TicketList /></RequireView>} />
        <Route path="tickets/new"          element={<NewTicket />} />
        <Route path="tickets/:id"          element={<TicketDetail />} />
        <Route path="inventory"            element={<InventoryList />} />
        <Route path="inventory/new"        element={<NewInventoryItem />} />
        <Route path="inventory/:id"        element={<InventoryDetail />} />
        <Route path="suppliers"            element={<SupplierList />} />
        <Route path="suppliers/new"        element={<NewSupplier />} />
        <Route path="suppliers/:id"        element={<SupplierDetail />} />
        <Route path="supplier-orders"      element={<PurchaseOrderList />} />
        <Route path="supplier-orders/new"  element={<NewPurchaseOrder />} />
        <Route path="maintenance/dashboard"      element={<RequireView resource="maintenance"><MaintenanceDashboard /></RequireView>} />
        <Route path="maintenance/supervisor"     element={<RequireView resource="supervisor_view"><SupervisorDashboard /></RequireView>} />
        <Route path="factory-map"                element={<RequireView resource="machines"><FactoryMap /></RequireView>} />
        <Route path="maintenance/wo-approval" element={<WOApproval />} />
        {/* legacy path → keep old links working */}
        <Route path="maintenance/parts-approval" element={<WOApproval />} />
        <Route path="machines"              element={<Navigate to="/equipment" replace />} />
        <Route path="my-work"               element={<MyWorkPage />} />
        <Route path="settings/machines"           element={<Navigate to="/equipment" replace />} />
        <Route path="settings/machines/:id"       element={<Navigate to="/equipment" replace />} />
        <Route path="settings/stop-categories"    element={<Navigate to="/equipment" replace />} />
        <Route path="settings/escalation"         element={<EscalationSettingsPage />} />
        <Route path="settings/users"              element={<UsersSetup />} />
        <Route path="settings/users/:id"          element={<UserDetail />} />
        <Route path="settings/profile"            element={<MyProfile />} />
        <Route path="settings/change-password"    element={<ChangePassword />} />
        <Route path="settings/intervention-types" element={<Navigate to="/equipment" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  </BrowserRouter>
  );
};

export default App;
