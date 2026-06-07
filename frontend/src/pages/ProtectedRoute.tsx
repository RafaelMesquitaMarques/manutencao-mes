import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

const FORCE_CHANGE_PATH = '/force-change-password';

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { isAuthenticated, user } = useAuthStore();
  const location = useLocation();

  if (!isAuthenticated) return <Navigate to="/login" replace />;

  if (user?.must_change_password && location.pathname !== FORCE_CHANGE_PATH) {
    return <Navigate to={FORCE_CHANGE_PATH} replace />;
  }

  return <>{children}</>;
};

export default ProtectedRoute;
