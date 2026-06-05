import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import ProtectedRoute from './pages/ProtectedRoute';
import Layout from './components/Layout/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import WorkOrderList from './pages/WorkOrders/WorkOrderList';
import WorkOrderDetail from './pages/WorkOrders/WorkOrderDetail';
import NewWorkOrder from './pages/WorkOrders/NewWorkOrder';

const App = () => (
  <BrowserRouter>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="work-orders" element={<WorkOrderList />} />
        <Route path="work-orders/new" element={<NewWorkOrder />} />
        <Route path="work-orders/:id" element={<WorkOrderDetail />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  </BrowserRouter>
);

export default App;
