import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from './pages/ProtectedRoute';
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
import EquipmentList from './pages/Equipment/EquipmentList';
import EquipmentDetail from './pages/Equipment/EquipmentDetail';
import NewEquipment from './pages/Equipment/NewEquipment';
import PMCalendar from './pages/PMCalendar/PMCalendar';
import LaborScheduler from './pages/Schedule/LaborScheduler';
import AlertList from './pages/Alerts/AlertList';
import NewAlert from './pages/Alerts/NewAlert';
import AlertDetail from './pages/Alerts/AlertDetail';
import TicketList from './pages/Tickets/TicketList';
import TicketDetail from './pages/Tickets/TicketDetail';
import MaintenanceDashboard from './pages/MaintenanceDashboard/MaintenanceDashboard';
import SupervisorDashboard from './pages/MaintenanceDashboard/SupervisorDashboard';
import MachineList from './pages/Machines/MachineList';
import MachinePage from './pages/Machines/MachinePage';
import MyWorkPage from './pages/MyWork/MyWorkPage';
import StopCategoriesPage from './pages/Settings/StopCategories';
import UsersSetup from './pages/Settings/UsersSetup';
import UserDetail from './pages/Settings/UserDetail';
import MyProfile from './pages/Settings/MyProfile';
import ChangePassword from './pages/Settings/ChangePassword';
import AcceptInvite from './pages/AcceptInvite';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';

const App = () => (
  <BrowserRouter>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/machines/:slug" element={<MachinePage />} />
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
        <Route path="work-orders"           element={<WorkOrderList />} />
        <Route path="work-orders/new"       element={<NewWorkOrder />} />
        <Route path="work-orders/:id"       element={<WorkOrderDetail />} />
        <Route path="technicians"           element={<TechnicianList />} />
        <Route path="technicians/new"       element={<NewTechnician />} />
        <Route path="technicians/:id"       element={<TechnicianDetail />} />
        <Route path="kpis"                  element={<KPIDashboard />} />
        <Route path="equipment"             element={<EquipmentList />} />
        <Route path="equipment/new"         element={<NewEquipment />} />
        <Route path="equipment/:id"         element={<EquipmentDetail />} />
        <Route path="pm-calendar"           element={<PMCalendar />} />
        <Route path="schedule"              element={<LaborScheduler />} />
        <Route path="alerts"               element={<AlertList />} />
        <Route path="alerts/new"            element={<NewAlert />} />
        <Route path="alerts/:id"            element={<AlertDetail />} />
        <Route path="tickets"              element={<TicketList />} />
        <Route path="tickets/:id"          element={<TicketDetail />} />
        <Route path="maintenance/dashboard"  element={<MaintenanceDashboard />} />
        <Route path="maintenance/supervisor" element={<SupervisorDashboard />} />
        <Route path="machines"              element={<MachineList />} />
        <Route path="my-work"               element={<MyWorkPage />} />
        <Route path="settings/machines"           element={<Navigate to="/equipment" replace />} />
        <Route path="settings/machines/:id"       element={<Navigate to="/equipment" replace />} />
        <Route path="settings/machines/:id/*"     element={<Navigate to="/equipment" replace />} />
        <Route path="settings/stop-categories"    element={<StopCategoriesPage />} />
        <Route path="settings/users"                          element={<UsersSetup />} />
        <Route path="settings/users/:id"                      element={<UserDetail />} />
        <Route path="settings/profile"                        element={<MyProfile />} />
        <Route path="settings/change-password"                element={<ChangePassword />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  </BrowserRouter>
);

export default App;
