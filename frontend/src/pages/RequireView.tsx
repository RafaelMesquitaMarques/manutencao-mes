import { Navigate } from 'react-router-dom';
import { usePermission } from '../hooks/usePermission';

/** Route guard: redirects to the dashboard if the user lacks `view` on the resource.
 *  Admin always passes (handled in authStore.can). Used to block direct-URL access
 *  to pages whose menu entry is hidden. */
export default function RequireView({ resource, children }: { resource: string; children: React.ReactNode }) {
  const allowed = usePermission(resource, 'view');
  if (!allowed) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
