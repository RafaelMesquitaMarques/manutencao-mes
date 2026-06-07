import { useEffect, useState, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  UserPlus, UserCheck, Mail, Settings, CheckCircle, XCircle,
  AlertCircle, X, Eye, EyeOff, KeyRound, Copy, Check,
} from 'lucide-react';
import { fetchUsers, deleteUser, createUser, adminResetPassword } from '../../api/users';
import { inviteUser } from '../../api/auth';
import type { User, UserRole } from '../../types';

const ROLE_LABELS: Record<string, string> = {
  operator:             'Operator',
  technician:           'Technician',
  supervisor:           'Supervisor',
  maintenance_director: 'Maint. Director',
  plant_manager:        'Plant Manager',
  director:             'Director',
  admin:                'Admin',
};

const ROLE_COLORS: Record<string, string> = {
  operator:             'text-gray-400 bg-gray-500/15 border-gray-600/30',
  technician:           'text-blue-400 bg-blue-500/15 border-blue-500/30',
  supervisor:           'text-purple-400 bg-purple-500/15 border-purple-500/30',
  maintenance_director: 'text-amber-400 bg-amber-500/15 border-amber-500/30',
  plant_manager:        'text-green-400 bg-green-500/15 border-green-500/30',
  director:             'text-cyan-400 bg-cyan-500/15 border-cyan-500/30',
  admin:                'text-red-400 bg-red-500/15 border-red-500/30',
};

const ALL_ROLES: UserRole[] = [
  'operator', 'technician', 'supervisor', 'maintenance_director',
  'plant_manager', 'director', 'admin',
];

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
];

// ─── Toast ─────────────────────────────────────────────────────────────────────

interface ToastProps {
  message: string;
  onDone: () => void;
}

function Toast({ message, onDone }: ToastProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timerRef.current = setTimeout(onDone, 3000);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [onDone]);

  return (
    <div className="fixed bottom-6 right-6 z-[100] flex items-center gap-2.5 px-4 py-3 bg-green-600 text-white rounded-xl shadow-2xl shadow-green-600/20 animate-slide-in">
      <CheckCircle size={16} className="flex-shrink-0" />
      <span className="text-sm font-medium">{message}</span>
      <button onClick={onDone} className="ml-2 opacity-70 hover:opacity-100 transition-opacity">
        <X size={14} />
      </button>
    </div>
  );
}

// ─── Invite Modal ──────────────────────────────────────────────────────────────

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
              <div className="mt-5">
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

// ─── Create User Modal ─────────────────────────────────────────────────────────

interface CreateUserModalProps {
  onClose: () => void;
  onSuccess: (name: string) => void;
}

function CreateUserModal({ onClose, onSuccess }: CreateUserModalProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState<UserRole>('technician');
  const [jobTitle, setJobTitle] = useState('');
  const [phone, setPhone] = useState('');
  const [language, setLanguage] = useState('en');
  const [mustChangePw, setMustChangePw] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const canSubmit = name.trim() && email.trim() && password.length >= 8;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    setError('');
    setLoading(true);
    try {
      await createUser({
        name: name.trim(),
        email: email.trim(),
        password,
        role,
        language,
        job_title: jobTitle.trim() || undefined,
        phone: phone.trim() || undefined,
        must_change_password: mustChangePw,
      });
      onSuccess(name.trim());
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? 'Failed to create user.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-[#0d1421] border border-white/[0.08] rounded-2xl w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
          <h3 className="text-white font-bold">Create User</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors p-1 rounded">
            <X size={16} />
          </button>
        </div>

        <div className="p-6 max-h-[80vh] overflow-y-auto">
          {error && (
            <div className="mb-5 flex items-start gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
              <AlertCircle size={15} className="text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Row 1: name + email */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">
                  Full name <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Smith"
                  className="input-field"
                  required
                  disabled={loading}
                  autoFocus
                />
              </div>
              <div>
                <label className="label">
                  Email <span className="text-red-400">*</span>
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="jane@foliot.com"
                  className="input-field"
                  required
                  disabled={loading}
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="label">
                Password <span className="text-red-400">*</span>
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Min. 8 characters"
                  className="input-field pr-10"
                  required
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              {password.length > 0 && password.length < 8 && (
                <p className="text-red-400 text-xs mt-1">Must be at least 8 characters</p>
              )}
            </div>

            {/* Row 2: role + language */}
            <div className="grid grid-cols-2 gap-3">
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
              <div>
                <label className="label">Language</label>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="input-field"
                  disabled={loading}
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>{l.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Row 3: job title + phone */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Job title <span className="text-gray-600 text-[10px] font-normal">optional</span></label>
                <input
                  type="text"
                  value={jobTitle}
                  onChange={(e) => setJobTitle(e.target.value)}
                  placeholder="Maintenance Tech"
                  className="input-field"
                  disabled={loading}
                />
              </div>
              <div>
                <label className="label">Phone <span className="text-gray-600 text-[10px] font-normal">optional</span></label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1 (555) 000-0000"
                  className="input-field"
                  disabled={loading}
                />
              </div>
            </div>

            {/* Must change password toggle */}
            <label className="flex items-center gap-3 cursor-pointer select-none py-1">
              <div
                onClick={() => setMustChangePw((v) => !v)}
                className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${
                  mustChangePw ? 'bg-blue-600' : 'bg-gray-700'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                    mustChangePw ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </div>
              <span className="text-sm text-gray-300">Must change password on first login</span>
            </label>

            {/* Actions */}
            <div className="flex gap-3 pt-1 border-t border-white/[0.06]">
              <button
                type="submit"
                disabled={loading || !canSubmit}
                className="btn-primary py-2 px-5 text-sm"
              >
                {loading ? (
                  <>
                    <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    Creating...
                  </>
                ) : (
                  'Create User'
                )}
              </button>
              <button type="button" onClick={onClose} className="btn-secondary py-2 px-4 text-sm">
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ─── Reset Password Modal ─────────────────────────────────────────────────────

interface ResetPasswordModalProps {
  user: User;
  onClose: () => void;
  onSuccess: (msg: string) => void;
}

function ResetPasswordModal({ user, onClose, onSuccess }: ResetPasswordModalProps) {
  const [mode, setMode] = useState<'choose' | 'generate' | 'manual' | 'done_generate' | 'done_manual'>('choose');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tempPassword, setTempPassword] = useState('');
  const [copied, setCopied] = useState(false);

  const handleGenerate = async () => {
    setLoading(true); setError('');
    try {
      const res = await adminResetPassword(user.id, 'generate');
      setTempPassword(res.temp_password ?? '');
      setMode('done_generate');
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? 'Failed to reset password.');
    } finally { setLoading(false); }
  };

  const handleManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    setLoading(true); setError('');
    try {
      await adminResetPassword(user.id, 'manual', password);
      setMode('done_manual');
      onSuccess(`Password updated for ${user.name}`);
      onClose();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? 'Failed to reset password.');
    } finally { setLoading(false); }
  };

  const copyTemp = useCallback(() => {
    navigator.clipboard.writeText(tempPassword);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [tempPassword]);

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-[#0d1421] border border-white/[0.08] rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-2.5">
            <KeyRound size={16} className="text-amber-400" />
            <h3 className="text-white font-bold">Reset Password</h3>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors p-1 rounded">
            <X size={16} />
          </button>
        </div>

        <div className="p-6">
          <p className="text-gray-400 text-sm mb-5">
            Resetting password for <span className="text-white font-medium">{user.name}</span>.
            The user will be required to change it on next login.
          </p>

          {error && (
            <div className="mb-4 flex items-start gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
              <AlertCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          {/* Choice screen */}
          {mode === 'choose' && (
            <div className="space-y-3">
              <button
                onClick={() => setMode('generate')}
                className="w-full p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05] hover:border-blue-500/30 transition-all text-left"
              >
                <p className="text-white font-medium text-sm">Generate temporary password</p>
                <p className="text-gray-500 text-xs mt-0.5">System creates a random 8-character password to share with the user</p>
              </button>
              <button
                onClick={() => setMode('manual')}
                className="w-full p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05] hover:border-blue-500/30 transition-all text-left"
              >
                <p className="text-white font-medium text-sm">Set password manually</p>
                <p className="text-gray-500 text-xs mt-0.5">You choose a new password for this user</p>
              </button>
            </div>
          )}

          {/* Confirm generate */}
          {mode === 'generate' && (
            <div className="space-y-4">
              <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                <p className="text-amber-400 text-sm">
                  A random 8-character password will be generated. You must communicate it to the user — it will only be shown once.
                </p>
              </div>
              <div className="flex gap-3">
                <button onClick={handleGenerate} disabled={loading} className="btn-primary py-2 px-5 text-sm">
                  {loading ? <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" /> : 'Generate & show'}
                </button>
                <button onClick={() => setMode('choose')} className="btn-secondary py-2 px-4 text-sm">Back</button>
              </div>
            </div>
          )}

          {/* Show generated temp password */}
          {mode === 'done_generate' && (
            <div className="space-y-4">
              <div className="p-3 bg-green-500/10 border border-green-500/25 rounded-lg flex items-center gap-2">
                <CheckCircle size={14} className="text-green-400 flex-shrink-0" />
                <p className="text-green-400 text-sm">Password reset. Share it with the user.</p>
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-1.5">Temporary password (shown once):</p>
                <div className="flex items-center gap-2 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5">
                  <span className="font-mono text-lg text-white tracking-widest flex-1 select-all">{tempPassword}</span>
                  <button
                    onClick={copyTemp}
                    className="text-gray-400 hover:text-white transition-colors flex-shrink-0"
                    title="Copy to clipboard"
                  >
                    {copied ? <Check size={16} className="text-green-400" /> : <Copy size={16} />}
                  </button>
                </div>
                <p className="text-amber-400 text-xs mt-2">⚠ This password will not be shown again after you close this dialog.</p>
              </div>
              <button onClick={onClose} className="btn-primary py-2 px-5 text-sm">Done</button>
            </div>
          )}

          {/* Manual form */}
          {mode === 'manual' && (
            <form onSubmit={handleManual} className="space-y-4">
              <div>
                <label className="label">New password</label>
                <div className="relative">
                  <input
                    type={showPw ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Min. 8 characters"
                    className="input-field pr-10"
                    autoFocus
                    required
                    disabled={loading}
                  />
                  <button type="button" onClick={() => setShowPw((v) => !v)} tabIndex={-1}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors">
                    {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                {password.length > 0 && password.length < 8 && (
                  <p className="text-red-400 text-xs mt-1">Must be at least 8 characters</p>
                )}
              </div>
              <div>
                <label className="label">Confirm password</label>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Repeat password"
                  className="input-field"
                  required
                  disabled={loading}
                />
                {confirm.length > 0 && password !== confirm && (
                  <p className="text-red-400 text-xs mt-1">Passwords do not match</p>
                )}
              </div>
              <div className="flex gap-3 pt-1">
                <button type="submit" disabled={loading || password.length < 8 || password !== confirm} className="btn-primary py-2 px-5 text-sm">
                  {loading ? <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" /> : 'Set password'}
                </button>
                <button type="button" onClick={() => setMode('choose')} className="btn-secondary py-2 px-4 text-sm">Back</button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function UsersSetup() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [deactivating, setDeactivating] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  const [toast, setToast] = useState<string | null>(null);

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

  const handleCreated = (name: string) => {
    setShowCreate(false);
    setToast(`${name} created successfully`);
    load();
  };

  return (
    <div className="min-h-screen bg-[#060c17] text-white p-6 max-w-4xl mx-auto">
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
      {showInvite && (
        <InviteModal onClose={() => setShowInvite(false)} onSuccess={load} />
      )}
      {showCreate && (
        <CreateUserModal onClose={() => setShowCreate(false)} onSuccess={handleCreated} />
      )}
      {resetTarget && (
        <ResetPasswordModal
          user={resetTarget}
          onClose={() => setResetTarget(null)}
          onSuccess={(msg) => { setToast(msg); setResetTarget(null); load(); }}
        />
      )}

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-black text-white">User Management</h1>
          <p className="text-sm text-gray-600 mt-1">Manage user accounts and access levels</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 py-2 px-4 rounded-lg text-sm font-medium bg-white/[0.06] text-gray-300 border border-white/[0.10] hover:bg-white/[0.10] hover:text-white transition-all"
          >
            <UserCheck size={14} />
            Create User
          </button>
          <button
            onClick={() => setShowInvite(true)}
            className="btn-primary py-2 px-4 text-sm"
          >
            <UserPlus size={14} />
            Invite User
          </button>
        </div>
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
                    {u.must_change_password && (
                      <span className="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded-full">
                        pw change required
                      </span>
                    )}
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
                  <button
                    onClick={() => setResetTarget(u)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-amber-400 border border-amber-500/30 hover:bg-amber-500/10 transition-all"
                    title="Reset password"
                  >
                    <KeyRound size={12} /> Reset pw
                  </button>
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
