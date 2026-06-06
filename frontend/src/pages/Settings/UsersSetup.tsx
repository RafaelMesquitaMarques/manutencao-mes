import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  UserPlus, Mail, Settings, CheckCircle, XCircle, AlertCircle, X,
} from 'lucide-react';
import { fetchUsers, deleteUser } from '../../api/users';
import { inviteUser } from '../../api/auth';
import type { User, UserRole } from '../../types';

const ROLE_LABELS: Record<string, string> = {
  operator: 'Operator',
  technician: 'Technician',
  supervisor: 'Supervisor',
  maintenance_director: 'Maint. Director',
  plant_manager: 'Plant Manager',
  director: 'Director',
  admin: 'Admin',
};

const ROLE_COLORS: Record<string, string> = {
  operator: 'text-gray-400 bg-gray-500/15 border-gray-600/30',
  technician: 'text-blue-400 bg-blue-500/15 border-blue-500/30',
  supervisor: 'text-purple-400 bg-purple-500/15 border-purple-500/30',
  maintenance_director: 'text-amber-400 bg-amber-500/15 border-amber-500/30',
  plant_manager: 'text-green-400 bg-green-500/15 border-green-500/30',
  director: 'text-cyan-400 bg-cyan-500/15 border-cyan-500/30',
  admin: 'text-red-400 bg-red-500/15 border-red-500/30',
};

const ALL_ROLES: UserRole[] = [
  'operator', 'technician', 'supervisor', 'maintenance_director',
  'plant_manager', 'director', 'admin',
];

interface InviteModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

function InviteModal({ onClose, onSuccess }: InviteModalProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('technician');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [token, setToken] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await inviteUser({ email, role });
      setToken(result.token);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? 'Failed to send invitation.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-[#0d1421] border border-white/[0.08] rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
          <h3 className="text-white font-bold">Invite User</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors p-1 rounded">
            <X size={16} />
          </button>
        </div>

        <div className="p-6">
          {token ? (
            <div>
              <div className="flex items-center gap-2.5 mb-4 p-3 bg-green-500/10 border border-green-500/25 rounded-lg">
                <CheckCircle size={15} className="text-green-400 flex-shrink-0" />
                <p className="text-green-400 text-sm">Invitation created!</p>
              </div>
              <p className="text-gray-400 text-sm mb-2">Share this token with the invited user:</p>
              <div className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5 font-mono text-xs text-gray-300 break-all select-all">
                {token}
              </div>
              <p className="text-gray-600 text-xs mt-2">
                They can use this at: <span className="text-gray-400">/accept-invite?token=…</span>
              </p>
              <div className="mt-5 flex gap-3">
                <button onClick={() => { onSuccess(); onClose(); }} className="btn-primary py-2 px-4 text-sm">
                  Done
                </button>
              </div>
            </div>
          ) : (
            <>
              {error && (
                <div className="mb-4 flex items-start gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
                  <AlertCircle size={15} className="text-red-400 flex-shrink-0 mt-0.5" />
                  <p className="text-red-400 text-sm">{error}</p>
                </div>
              )}
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="label">Email address</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="user@foliot.com"
                    className="input-field"
                    required
                    disabled={loading}
                  />
                </div>
                <div>
                  <label className="label">Role</label>
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value as UserRole)}
                    className="input-field"
                    disabled={loading}
                  >
                    {ALL_ROLES.map((r) => (
                      <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-3 pt-1">
                  <button type="submit" disabled={loading || !email} className="btn-primary py-2 px-4 text-sm">
                    {loading ? (
                      <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    ) : (
                      'Send Invitation'
                    )}
                  </button>
                  <button type="button" onClick={onClose} className="btn-secondary py-2 px-4 text-sm">
                    Cancel
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function UsersSetup() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [deactivating, setDeactivating] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    fetchUsers()
      .then(setUsers)
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleDeactivate = async (user: User) => {
    if (!confirm(`Deactivate ${user.name}?`)) return;
    setDeactivating(user.id);
    try {
      await deleteUser(user.id);
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
    } finally {
      setDeactivating(null);
    }
  };

  return (
    <div className="min-h-screen bg-[#060c17] text-white p-6 max-w-4xl mx-auto">
      {showInvite && (
        <InviteModal onClose={() => setShowInvite(false)} onSuccess={load} />
      )}

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-black text-white">User Management</h1>
          <p className="text-sm text-gray-600 mt-1">Manage user accounts and access levels</p>
        </div>
        <button
          onClick={() => setShowInvite(true)}
          className="btn-primary py-2 px-4 text-sm"
        >
          <UserPlus size={14} />
          Invite User
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-2">
          {users.map((u) => {
            const role = (u.role ?? 'operator') as string;
            return (
              <div
                key={u.id}
                className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-4 flex items-center gap-4"
              >
                {/* Avatar */}
                <div className="w-9 h-9 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center flex-shrink-0">
                  <span className="text-blue-400 font-bold text-xs">
                    {u.name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
                  </span>
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-base font-bold text-white truncate">{u.name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <Mail size={11} className="text-gray-600" />
                    <span className="text-xs text-gray-600 truncate">{u.email}</span>
                  </div>
                </div>

                <span className={`px-2 py-0.5 rounded-full border text-xs font-medium ${ROLE_COLORS[role] ?? ROLE_COLORS.operator}`}>
                  {ROLE_LABELS[role] ?? role}
                </span>

                <div className="flex items-center gap-1.5">
                  {u.active ? (
                    <span className="flex items-center gap-1 text-xs text-green-400">
                      <CheckCircle size={11} /> Active
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs text-red-400">
                      <XCircle size={11} /> Inactive
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <Link
                    to={`/settings/users/${u.id}`}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-blue-600/20 text-blue-400 border border-blue-500/30 hover:bg-blue-600/30 transition-all font-bold"
                  >
                    <Settings size={12} /> Manage
                  </Link>
                  {u.active && (
                    <button
                      onClick={() => handleDeactivate(u)}
                      disabled={deactivating === u.id}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-red-400 border border-red-500/30 hover:bg-red-500/10 transition-all"
                    >
                      <XCircle size={12} />
                      {deactivating === u.id ? '...' : 'Deactivate'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {users.length === 0 && (
            <div className="text-center py-16 text-gray-700">No users found.</div>
          )}
        </div>
      )}
    </div>
  );
}
