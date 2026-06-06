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
import KPIDashboard from './pages/KPIs/KPIDashboard';
import EquipmentList from './pages/Equipment/EquipmentList';
import EquipmentDetail from './pages/Equipment/EquipmentDetail';
import PMCalendar from './pages/PMCalendar/PMCalendar';
import LaborScheduler from './pages/Schedule/LaborScheduler';
import AlertList from './pages/Alerts/AlertList';
import NewAlert from './pages/Alerts/NewAlert';
import TicketList from './pages/Tickets/TicketList';
import TicketDetail from './pages/Tickets/TicketDetail';
import MaintenanceDashboard from './pages/MaintenanceDashboard/MaintenanceDashboard';
import SupervisorDashboard from './pages/MaintenanceDashboard/SupervisorDashboard';
import MachineList from './pages/Machines/MachineList';
import MachinePage from './pages/Machines/MachinePage';
import MyWorkPage from './pages/MyWork/MyWorkPage';
import StopCategoriesPage from './pages/Settings/StopCategories';
import MachinesSetup from './pages/Settings/MachinesSetup';
import MachineConfig from './pages/Settings/MachineConfig';
import MachineOperators from './pages/Settings/MachineOperators';

const App = () => (
  <BrowserRouter>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/machines/:slug" element={<MachinePage />} />
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
        <Route path="kpis"                  element={<KPIDashboard />} />
        <Route path="equipment"             element={<EquipmentList />} />
        <Route path="equipment/:id"         element={<EquipmentDetail />} />
        <Route path="pm-calendar"           element={<PMCalendar />} />
        <Route path="schedule"              element={<LaborScheduler />} />
        <Route path="alerts"                element={<AlertList />} />
        <Route path="alerts/new"            element={<NewAlert />} />
        <Route path="tickets"               element={<TicketList />} />
        <Route path="tickets/:id"           element={<TicketDetail />} />
        <Route path="maintenance/dashboard"  element={<MaintenanceDashboard />} />
        <Route path="maintenance/supervisor" element={<SupervisorDashboard />} />
        <Route path="machines"              element={<MachineList />} />
        <Route path="my-work"               element={<MyWorkPage />} />
        <Route path="settings/machines"                       element={<MachinesSetup />} />
        <Route path="settings/machines/:id/config"            element={<MachineConfig />} />
        <Route path="settings/machines/:id/operators"         element={<MachineOperators />} />
        <Route path="settings/stop-categories"                element={<StopCategoriesPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  </BrowserRouter>
);

export default App;
