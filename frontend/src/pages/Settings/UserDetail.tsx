import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, User, Shield, Building2, Activity, CheckCircle, AlertCircle, Plus, Trash2, type LucideIcon } from 'lucide-react';
import { fetchUser, updateUser, fetchUserPermissions, setUserPermissions, fetchUserPlants, assignUserToPlant, removeUserFromPlant } from '../../api/users';
import api from '../../api/axios';
import type { User as UserType, UserPermission, UserRole } from '../../types';

type Tab = 'profile' | 'permissions' | 'plants' | 'activity';

const TABS: { id: Tab; label: string; Icon: LucideIcon }[] = [
  { id: 'profile', label: 'Profile', Icon: User },
  { id: 'permissions', label: 'Permissions', Icon: Shield },
  { id: 'plants', label: 'Plant Access', Icon: Building2 },
  { id: 'activity', label: 'Activity', Icon: Activity },
];

const ALL_ROLES: UserRole[] = [
  'operator', 'technician', 'supervisor', 'maintenance_director',
  'plant_manager', 'director', 'admin',
];

const ROLE_LABELS: Record<UserRole, string> = {
  operator: 'Operator',
  technician: 'Technician',
  supervisor: 'Supervisor',
  maintenance_director: 'Maintenance Director',
  plant_manager: 'Plant Manager',
  director: 'Director',
  admin: 'Administrator',
};

const RESOURCES = [
  'dashboard', 'work_orders', 'technicians', 'equipment', 'my_work',
  'alerts', 'tickets', 'maintenance', 'supervisor_view', 'machines',
  'schedule', 'pm_calendar', 'kpis', 'settings_machines', 'settings_users',
];

const ACTIONS = ['view', 'create', 'update', 'delete'];

// ─── Profile Tab ──────────────────────────────────────────────────────────────

function ProfileTab({ user }: { user: UserType }) {
  const [name, setName] = useState(user.name);
  const [jobTitle, setJobTitle] = useState(user.job_title ?? '');
  const [phone, setPhone] = useState(user.phone ?? '');
  const [role, setRole] = useState<UserRole>((user.role ?? 'operator') as UserRole);
  const [mustChange, setMustChange] = useState(user.must_change_password ?? false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess(false);
    setLoading(true);
    try {
      await updateUser(user.id, { name, job_title: jobTitle, phone, role, must_change_password: mustChange });
      setSuccess(true);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? 'Failed to update user.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSave} className="space-y-4">
      {success && (
        <div className="flex items-center gap-2.5 p-3 bg-green-500/10 border border-green-500/25 rounded-lg">
          <CheckCircle size={14} className="text-green-400" />
          <p className="text-green-400 text-sm">Changes saved.</p>
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
          <AlertCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Full name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="input-field" required disabled={loading} />
        </div>
        <div>
          <label className="label">Job title</label>
          <input type="text" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} className="input-field" disabled={loading} />
        </div>
        <div>
          <label className="label">Phone</label>
          <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="input-field" disabled={loading} />
        </div>
        <div>
          <label className="label">Role</label>
          <select value={role} onChange={(e) => setRole(e.target.value as UserRole)} className="input-field" disabled={loading}>
            {ALL_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        </div>
      </div>

      <label className="flex items-center gap-2.5 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={mustChange}
          onChange={(e) => setMustChange(e.target.checked)}
          className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-blue-500"
          disabled={loading}
        />
        <span className="text-sm text-gray-300">Require password change on next login</span>
      </label>

      <div className="pt-1">
        <button type="submit" disabled={loading} className="btn-primary py-2 px-5 text-sm">
          {loading ? (
            <><span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" /> Saving...</>
          ) : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

// ─── Permissions Tab ─────────────────────────────────────────────────────────

function PermissionsTab({ userId }: { userId: string }) {
  const [overrides, setOverrides] = useState<UserPermission[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  const load = useCallback(() => {
    fetchUserPermissions(userId)
      .then(setOverrides)
      .finally(() => setLoading(false));
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const toggleOverride = (resource: string, action: string) => {
    setOverrides((prev) => {
      const existing = prev.find((p) => p.resource === resource && p.action === action);
      if (existing) {
        return prev.filter((p) => !(p.resource === resource && p.action === action));
      }
      return [...prev, { id: `${resource}-${action}`, resource, action, granted: true }];
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setSuccess(false);
    try {
      await setUserPermissions(userId, overrides.map((p) => ({
        resource: p.resource, action: p.action, granted: p.granted,
      })));
      setSuccess(true);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="py-8 flex justify-center"><div className="w-6 h-6 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" /></div>;

  return (
    <div>
      <p className="text-xs text-gray-500 mb-4">
        These override the user's role defaults. Leave empty to use role defaults.
      </p>
      {success && (
        <div className="mb-4 flex items-center gap-2.5 p-3 bg-green-500/10 border border-green-500/25 rounded-lg">
          <CheckCircle size={14} className="text-green-400" />
          <p className="text-green-400 text-sm">Permissions saved.</p>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/[0.06]">
              <th className="text-left py-2 pr-4 text-gray-500 font-medium text-xs uppercase tracking-wider">Resource</th>
              {ACTIONS.map((a) => (
                <th key={a} className="text-center py-2 px-3 text-gray-500 font-medium text-xs uppercase tracking-wider">
                  {a}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {RESOURCES.map((resource) => (
              <tr key={resource} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                <td className="py-2 pr-4 text-gray-300 font-mono text-xs">{resource}</td>
                {ACTIONS.map((action) => {
                  const active = overrides.some((p) => p.resource === resource && p.action === action && p.granted);
                  return (
                    <td key={action} className="py-2 px-3 text-center">
                      <button
                        onClick={() => toggleOverride(resource, action)}
                        className={`w-5 h-5 rounded border transition-all ${
                          active
                            ? 'bg-blue-600 border-blue-500 text-white'
                            : 'bg-gray-800 border-gray-700 text-transparent hover:border-gray-500'
                        }`}
                      >
                        <CheckCircle size={12} className="mx-auto" />
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4">
        <button onClick={handleSave} disabled={saving} className="btn-primary py-2 px-5 text-sm">
          {saving ? 'Saving...' : 'Save overrides'}
        </button>
      </div>
    </div>
  );
}

// ─── Plant Access Tab ─────────────────────────────────────────────────────────

interface PlantItem { id: string; code: string; name: string }

function PlantAccessTab({ userId }: { userId: string }) {
  const [allPlants, setAllPlants]           = useState<PlantItem[]>([]);
  const [assignedIds, setAssignedIds]       = useState<Set<string>>(new Set());
  const [loading, setLoading]               = useState(true);
  const [actionId, setActionId]             = useState<string | null>(null);
  const [selectedRole, setSelectedRole]     = useState<UserRole>('technician');
  const [error, setError]                   = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const [plants, userPlants] = await Promise.all([
      api.get<PlantItem[]>('/api/plants/').then((r) => r.data).catch(() => []),
      fetchUserPlants(userId).catch(() => []),
    ]);
    setAllPlants(plants);
    setAssignedIds(new Set(userPlants.map((p) => p.plant_id)));
    setLoading(false);
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const handleAssign = async (plantId: string) => {
    setActionId(plantId);
    setError('');
    try {
      await assignUserToPlant(userId, plantId, selectedRole);
      setAssignedIds((prev) => new Set([...prev, plantId]));
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(detail ?? 'Failed to assign plant.');
    } finally {
      setActionId(null);
    }
  };

  const handleRemove = async (plantId: string) => {
    setActionId(plantId);
    setError('');
    try {
      await removeUserFromPlant(userId, plantId);
      setAssignedIds((prev) => { const s = new Set(prev); s.delete(plantId); return s; });
    } catch {
      setError('Failed to remove plant.');
    } finally {
      setActionId(null);
    }
  };

  if (loading) return <div className="py-8 flex justify-center"><div className="w-6 h-6 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" /></div>;

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
          <AlertCircle size={14} className="text-red-400 flex-shrink-0" />
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}
      <div className="flex items-center gap-3 mb-2">
        <label className="text-xs text-gray-500">Role when assigning:</label>
        <select
          value={selectedRole}
          onChange={(e) => setSelectedRole(e.target.value as UserRole)}
          className="input-field py-1 text-xs w-auto"
        >
          {(['operator','technician','supervisor','maintenance_director','plant_manager'] as UserRole[]).map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </div>
      {allPlants.length === 0 ? (
        <p className="text-gray-600 text-sm text-center py-4">No plants configured.</p>
      ) : (
        <div className="space-y-2">
          {allPlants.map((plant) => {
            const assigned = assignedIds.has(plant.id);
            return (
              <div key={plant.id} className="flex items-center justify-between p-3 rounded-lg border border-white/[0.06] bg-white/[0.02]">
                <div>
                  <p className="text-gray-200 text-sm font-medium">{plant.name}</p>
                  <p className="text-gray-600 text-xs font-mono">{plant.code}</p>
                </div>
                {assigned ? (
                  <button
                    onClick={() => handleRemove(plant.id)}
                    disabled={actionId === plant.id}
                    className="btn-danger py-1 px-3 text-xs gap-1"
                  >
                    <Trash2 size={12} /> Remove
                  </button>
                ) : (
                  <button
                    onClick={() => handleAssign(plant.id)}
                    disabled={actionId === plant.id}
                    className="btn-secondary py-1 px-3 text-xs gap-1"
                  >
                    <Plus size={12} /> Assign
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function UserDetail() {
  const { id } = useParams<{ id: string }>();
  const [user, setUser] = useState<UserType | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('profile');

  useEffect(() => {
    if (!id) return;
    fetchUser(id)
      .then(setUser)
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return (
    <div className="flex justify-center items-center min-h-screen bg-[#060c17]">
      <div className="w-8 h-8 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
    </div>
  );

  if (!user) return (
    <div className="min-h-screen bg-[#060c17] flex items-center justify-center text-gray-600">User not found.</div>
  );

  const initials = user.name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div className="min-h-screen bg-[#060c17] text-white p-6 max-w-4xl mx-auto">
      <Link to="/settings/users" className="flex items-center gap-2 text-gray-500 hover:text-gray-300 text-sm mb-6 transition-colors">
        <ArrowLeft size={14} /> Back to Users
      </Link>

      <div className="flex items-center gap-4 mb-8">
        <div className="w-12 h-12 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center flex-shrink-0">
          <span className="text-blue-400 font-bold">{initials}</span>
        </div>
        <div>
          <h1 className="text-xl font-black text-white">{user.name}</h1>
          <p className="text-sm text-gray-500">{user.email}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-[#0d1421]/60 rounded-xl p-1 border border-white/[0.06]">
        {TABS.map(({ id: tabId, label, Icon }) => (
          <button
            key={tabId}
            onClick={() => setTab(tabId)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-all flex-1 justify-center ${
              tab === tabId
                ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      <div className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-6">
        {tab === 'profile' && <ProfileTab user={user} />}
        {tab === 'permissions' && <PermissionsTab userId={user.id} />}
        {tab === 'plants' && <PlantAccessTab userId={user.id} />}
        {tab === 'activity' && (
          <div className="space-y-2">
            {user.last_login_at ? (
              <div className="text-sm text-gray-400">
                Last login: <span className="text-gray-300">{new Date(user.last_login_at).toLocaleString()}</span>
              </div>
            ) : (
              <p className="text-gray-600 text-sm">No login activity recorded.</p>
            )}
            {user.invited_at && (
              <div className="text-sm text-gray-400">
                Joined via invitation: <span className="text-gray-300">{new Date(user.invited_at).toLocaleString()}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
