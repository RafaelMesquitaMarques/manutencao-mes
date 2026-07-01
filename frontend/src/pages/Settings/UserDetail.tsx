import { useEffect, useState, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, User, Shield, Building2, Activity, CheckCircle, AlertCircle, Plus, Trash2, KeyRound, type LucideIcon } from 'lucide-react';
import { fetchUser, updateUser, fetchUserPermissions, setUserPermissions, fetchUserPlants, assignUserToPlant, removeUserFromPlant, adminResetPassword, deleteUser, deleteUserPermanently } from '../../api/users';
import api from '../../api/axios';
import type { User as UserType, UserPermission, UserRole } from '../../types';
import { ROLE_PERMISSIONS } from '../../store/authStore';

type Tab = 'profile' | 'permissions' | 'plants' | 'activity' | 'security';

const TABS: { id: Tab; labelKey: string; Icon: LucideIcon }[] = [
  { id: 'profile', labelKey: 'users.tabProfile', Icon: User },
  { id: 'permissions', labelKey: 'users.tabPermissions', Icon: Shield },
  { id: 'plants', labelKey: 'users.tabPlants', Icon: Building2 },
  { id: 'activity', labelKey: 'users.tabActivity', Icon: Activity },
  { id: 'security', labelKey: 'users.tabSecurity', Icon: KeyRound },
];

const ALL_ROLES: UserRole[] = [
  'operator', 'technician', 'supervisor', 'maintenance_director',
  'plant_manager', 'director', 'admin',
];

const RESOURCES = [
  'dashboard', 'work_orders', 'technicians', 'equipment', 'my_work',
  'alerts', 'tickets', 'maintenance', 'supervisor_view', 'factory_map',
  'dashboards', 'wo_approval', 'schedule', 'pm_calendar', 'maintenance_plans',
  'inventory', 'suppliers', 'purchase_orders', 'machines', 'kpis',
  'machine_reports', 'intelligence', 'settings_machines', 'settings_escalation',
  'settings_users',
];

const ACTIONS = ['view', 'create', 'update', 'delete'];

// ─── Profile Tab ──────────────────────────────────────────────────────────────

function ProfileTab({ user, onUpdated }: { user: UserType; onUpdated: (u: UserType) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
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
      const updated = await updateUser(user.id, {
        name, email: email.trim(), job_title: jobTitle, phone, role, must_change_password: mustChange,
      });
      setSuccess(true);
      onUpdated(updated);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? t('users.updateUserFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSave} className="space-y-4">
      {success && (
        <div className="flex items-center gap-2.5 p-3 bg-green-500/10 border border-green-500/25 rounded-lg">
          <CheckCircle size={14} className="text-green-400" />
          <p className="text-green-400 text-sm">{t('users.changesSaved')}</p>
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
          <label className="label">{t('settings.fullName')}</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="input-field" required disabled={loading} />
        </div>
        <div>
          <label className="label">{t('users.emailLogin')}</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input-field" required disabled={loading} />
        </div>
        <div>
          <label className="label">{t('users.jobTitle')}</label>
          <input type="text" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} className="input-field" disabled={loading} />
        </div>
        <div>
          <label className="label">{t('settings.phone')}</label>
          <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="input-field" disabled={loading} />
        </div>
        <div>
          <label className="label">{t('users.role')}</label>
          <select value={role} onChange={(e) => setRole(e.target.value as UserRole)} className="input-field" disabled={loading}>
            {ALL_ROLES.map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}
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
        <span className="text-sm text-gray-300">{t('users.requirePwChange')}</span>
      </label>

      <div className="pt-1">
        <button type="submit" disabled={loading} className="btn-primary py-2 px-5 text-sm">
          {loading ? (
            <><span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" /> {t('settings.saving')}</>
          ) : t('settings.saveChanges')}
        </button>
      </div>
    </form>
  );
}

// ─── Permissions Tab ─────────────────────────────────────────────────────────

function PermissionsTab({ userId, userRole }: { userId: string; userRole: string }) {
  const { t } = useTranslation();
  const [overrides, setOverrides] = useState<UserPermission[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [seeded, setSeeded] = useState(false);

  const load = useCallback(() => {
    fetchUserPermissions(userId)
      .then((rows) => {
        if (rows.length === 0) {
          // No saved overrides → pre-fill from the role defaults so the admin
          // edits from the baseline (saving captures the full allow-list).
          const base = Array.from(ROLE_PERMISSIONS[userRole] ?? []).map((p) => {
            const [resource, action] = p.split(':');
            return { id: `${resource}-${action}`, resource, action, granted: true };
          });
          setOverrides(base);
          setSeeded(true);
        } else {
          setOverrides(rows);
          setSeeded(false);
        }
      })
      .finally(() => setLoading(false));
  }, [userId, userRole]);

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
        {t('users.permChecked')}
        {seeded && <span className="text-amber-400"> {t('users.permSeededPrefix')} <b>{userRole}</b> {t('users.permSeededSuffix')}</span>}
        {' '}{t('users.permFallback')}
      </p>
      {success && (
        <div className="mb-4 flex items-center gap-2.5 p-3 bg-green-500/10 border border-green-500/25 rounded-lg">
          <CheckCircle size={14} className="text-green-400" />
          <p className="text-green-400 text-sm">{t('users.permSaved')}</p>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/[0.06]">
              <th className="text-left py-2 pr-4 text-gray-500 font-medium text-xs uppercase tracking-wider">{t('users.resource')}</th>
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
          {saving ? t('settings.saving') : t('users.saveOverrides')}
        </button>
      </div>
    </div>
  );
}

// ─── Plant Access Tab ─────────────────────────────────────────────────────────

interface PlantItem { id: string; code: string; name: string }

function PlantAccessTab({ userId }: { userId: string }) {
  const { t } = useTranslation();
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
      setError(detail ?? t('users.assignPlantFailed'));
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
      setError(t('users.removePlantFailed'));
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
        <label className="text-xs text-gray-500">{t('users.roleWhenAssigning')}</label>
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
        <p className="text-gray-600 text-sm text-center py-4">{t('users.noPlants')}</p>
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
                    <Trash2 size={12} /> {t('users.remove')}
                  </button>
                ) : (
                  <button
                    onClick={() => handleAssign(plant.id)}
                    disabled={actionId === plant.id}
                    className="btn-secondary py-1 px-3 text-xs gap-1"
                  >
                    <Plus size={12} /> {t('users.assign')}
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

// ─── Security Tab ────────────────────────────────────────────────────────────

function SecurityTab({ user, onUpdated }: { user: UserType; onUpdated: (u: UserType) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [resetMode, setResetMode] = useState<'idle' | 'choose' | 'generate' | 'manual' | 'done_generate'>('idle');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tempPassword, setTempPassword] = useState('');
  const [copied, setCopied] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [dangerMode, setDangerMode] = useState<'idle' | 'confirm'>('idle');
  const [confirmName, setConfirmName] = useState('');
  const [dangerErr, setDangerErr] = useState('');
  const [dangerBusy, setDangerBusy] = useState(false);

  const handleDeactivate = async () => {
    setDangerBusy(true);
    setDangerErr('');
    try {
      await deleteUser(user.id);
      onUpdated({ ...user, active: false });
      setSuccessMsg(t('users.userDeactivated'));
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setDangerErr(msg ?? t('users.deactivateFailed'));
    } finally {
      setDangerBusy(false);
    }
  };

  const handleHardDelete = async () => {
    setDangerBusy(true);
    setDangerErr('');
    try {
      await deleteUserPermanently(user.id);
      navigate('/settings/users');
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setDangerErr(msg ?? t('users.deleteFailed'));
    } finally {
      setDangerBusy(false);
    }
  };

  const handleReactivate = async () => {
    setDangerBusy(true);
    setDangerErr('');
    try {
      const updated = await updateUser(user.id, { active: true });
      onUpdated(updated);
      setSuccessMsg(t('users.userReactivated'));
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setDangerErr(msg ?? t('users.reactivateFailed'));
    } finally {
      setDangerBusy(false);
    }
  };

  const handleGenerate = async () => {
    setLoading(true); setError('');
    try {
      const res = await adminResetPassword(user.id, 'generate');
      setTempPassword(res.temp_password ?? '');
      setResetMode('done_generate');
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? t('users.resetFailed'));
    } finally { setLoading(false); }
  };

  const handleManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { setError(t('users.passwordsNoMatchMsg')); return; }
    setLoading(true); setError('');
    try {
      await adminResetPassword(user.id, 'manual', password);
      setSuccessMsg(t('users.passwordUpdatedMsg'));
      setResetMode('idle');
      setPassword(''); setConfirm('');
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? t('users.resetFailed'));
    } finally { setLoading(false); }
  };

  const copyTemp = () => {
    navigator.clipboard.writeText(tempPassword);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Status info */}
      <div className="grid grid-cols-2 gap-4">
        <div className="p-4 rounded-xl border border-white/[0.06] bg-white/[0.02]">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-1.5">{t('users.lastLogin')}</p>
          <p className="text-sm text-gray-200">
            {user.last_login_at ? new Date(user.last_login_at).toLocaleString() : t('users.never')}
          </p>
        </div>
        <div className="p-4 rounded-xl border border-white/[0.06] bg-white/[0.02]">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-1.5">{t('users.passwordChange')}</p>
          {user.must_change_password ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-1 rounded-full">
              <AlertCircle size={11} /> {t('users.requiredNextLogin')}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-400 bg-green-500/10 border border-green-500/20 px-2 py-1 rounded-full">
              <CheckCircle size={11} /> {t('users.notRequired')}
            </span>
          )}
        </div>
      </div>

      {successMsg && (
        <div className="flex items-center gap-2.5 p-3 bg-green-500/10 border border-green-500/25 rounded-lg">
          <CheckCircle size={14} className="text-green-400" />
          <p className="text-green-400 text-sm">{successMsg}</p>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
          <AlertCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {/* Reset password section */}
      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
          <KeyRound size={14} className="text-gray-500" /> {t('users.resetPassword')}
        </h3>

        {resetMode === 'idle' && (
          <button
            onClick={() => setResetMode('choose')}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-amber-400 border border-amber-500/30 hover:bg-amber-500/10 transition-all"
          >
            <KeyRound size={14} /> {t('users.resetPwForUser')}
          </button>
        )}

        {resetMode === 'choose' && (
          <div className="space-y-3">
            <button
              onClick={() => setResetMode('generate')}
              className="w-full p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05] hover:border-blue-500/30 transition-all text-left"
            >
              <p className="text-white font-medium text-sm">{t('users.genTempTitle')}</p>
              <p className="text-gray-500 text-xs mt-0.5">{t('users.genTempDescShort')}</p>
            </button>
            <button
              onClick={() => setResetMode('manual')}
              className="w-full p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05] hover:border-blue-500/30 transition-all text-left"
            >
              <p className="text-white font-medium text-sm">{t('users.setManualTitle')}</p>
              <p className="text-gray-500 text-xs mt-0.5">{t('users.setManualDesc')}</p>
            </button>
            <button onClick={() => setResetMode('idle')} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">{t('common.cancel')}</button>
          </div>
        )}

        {resetMode === 'generate' && (
          <div className="space-y-3">
            <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
              <p className="text-amber-400 text-sm">{t('users.genWarn')}</p>
            </div>
            <div className="flex gap-3">
              <button onClick={handleGenerate} disabled={loading} className="btn-primary py-2 px-5 text-sm">
                {loading ? <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" /> : t('users.generateShow')}
              </button>
              <button onClick={() => setResetMode('choose')} className="btn-secondary py-2 px-4 text-sm">{t('common.back')}</button>
            </div>
          </div>
        )}

        {resetMode === 'done_generate' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 p-3 bg-green-500/10 border border-green-500/25 rounded-lg">
              <CheckCircle size={14} className="text-green-400 flex-shrink-0" />
              <p className="text-green-400 text-sm">{t('users.resetDoneShare')}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1.5">{t('users.tempPasswordShownOnce')}</p>
              <div className="flex items-center gap-2 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2.5">
                <span className="font-mono text-lg text-white tracking-widest flex-1 select-all">{tempPassword}</span>
                <button onClick={copyTemp} className="text-gray-400 hover:text-white transition-colors" title={t('users.copy')}>
                  {copied
                    ? <CheckCircle size={16} className="text-green-400" />
                    : <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                  }
                </button>
              </div>
              <p className="text-amber-400 text-xs mt-2">{t('users.tempWarn')}</p>
            </div>
            <button onClick={() => setResetMode('idle')} className="btn-secondary py-2 px-4 text-sm">{t('users.done')}</button>
          </div>
        )}

        {resetMode === 'idle' && (
          <div className="mt-8 pt-6 border-t border-red-500/15">
            <h3 className="text-sm font-semibold text-red-400 mb-1 flex items-center gap-2">
              <Trash2 size={14} /> {t('users.dangerZone')}
            </h3>
            <p className="text-xs text-gray-600 mb-3">
              {t('users.dangerDesc')}
            </p>
            {dangerErr && (
              <div className="mb-3 flex items-start gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
                <AlertCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
                <p className="text-red-400 text-sm">{dangerErr}</p>
              </div>
            )}
            {dangerMode === 'idle' ? (
              <div className="flex flex-wrap gap-3">
                {user.active ? (
                  <button
                    onClick={handleDeactivate}
                    disabled={dangerBusy}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-amber-400 border border-amber-500/30 hover:bg-amber-500/10 transition-all disabled:opacity-50"
                  >
                    {t('users.deactivateUser')}
                  </button>
                ) : (
                  <button
                    onClick={handleReactivate}
                    disabled={dangerBusy}
                    className="px-4 py-2 rounded-lg text-sm font-semibold text-green-400 border border-green-500/30 hover:bg-green-500/10 transition-all disabled:opacity-50"
                  >
                    {dangerBusy ? t('users.reactivating') : t('users.reactivateUser')}
                  </button>
                )}
                <button
                  onClick={() => { setDangerMode('confirm'); setConfirmName(''); setDangerErr(''); }}
                  disabled={dangerBusy}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-red-400 border border-red-500/30 hover:bg-red-500/10 transition-all disabled:opacity-50"
                >
                  {t('users.deletePermanently')}
                </button>
              </div>
            ) : (
              <div className="space-y-3 p-4 bg-red-500/5 border border-red-500/20 rounded-xl max-w-md">
                <p className="text-sm text-red-300">
                  {t('users.deleteConfirmPrompt')}
                  <span className="block font-mono text-white mt-1">{user.name}</span>
                </p>
                <input
                  value={confirmName}
                  onChange={(e) => setConfirmName(e.target.value)}
                  placeholder={t('users.typeFullName')}
                  className="input-field w-full"
                  disabled={dangerBusy}
                  autoFocus
                />
                <div className="flex gap-3">
                  <button
                    onClick={handleHardDelete}
                    disabled={dangerBusy || confirmName.trim() !== user.name}
                    className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-red-600 hover:bg-red-500 transition-all disabled:opacity-40"
                  >
                    {dangerBusy ? t('users.deleting') : t('users.deletePermanentlyBtn')}
                  </button>
                  <button
                    onClick={() => setDangerMode('idle')}
                    disabled={dangerBusy}
                    className="btn-secondary py-2 px-4 text-sm"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {resetMode === 'manual' && (
          <form onSubmit={handleManual} className="space-y-3">
            <div>
              <label className="label">{t('settings.newPassword')}</label>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('settings.min8chars')}
                  className="input-field pr-10"
                  autoFocus required disabled={loading}
                />
                <button type="button" onClick={() => setShowPw((v) => !v)} tabIndex={-1}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors">
                  {showPw
                    ? <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>
                    : <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                  }
                </button>
              </div>
              {password.length > 0 && password.length < 8 && <p className="text-red-400 text-xs mt-1">{t('settings.mustBe8')}</p>}
            </div>
            <div>
              <label className="label">{t('users.confirmPassword')}</label>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                placeholder={t('users.repeatPassword')} className="input-field" required disabled={loading} />
              {confirm.length > 0 && password !== confirm && <p className="text-red-400 text-xs mt-1">{t('users.passwordsDoNotMatch')}</p>}
            </div>
            <div className="flex gap-3 pt-1">
              <button type="submit" disabled={loading || password.length < 8 || password !== confirm} className="btn-primary py-2 px-5 text-sm">
                {loading ? <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" /> : t('users.setPassword')}
              </button>
              <button type="button" onClick={() => setResetMode('choose')} className="btn-secondary py-2 px-4 text-sm">{t('common.back')}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function UserDetail() {
  const { t } = useTranslation();
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
    <div className="min-h-screen bg-[#060c17] flex items-center justify-center text-gray-600">{t('users.userNotFound')}</div>
  );

  const initials = user.name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div className="min-h-screen bg-[#060c17] text-white p-6 max-w-4xl mx-auto">
      <Link to="/settings/users" className="flex items-center gap-2 text-gray-500 hover:text-gray-300 text-sm mb-6 transition-colors">
        <ArrowLeft size={14} /> {t('users.backToUsers')}
      </Link>

      <div className="flex items-center gap-4 mb-8">
        <div className="w-12 h-12 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center flex-shrink-0">
          <span className="text-blue-400 font-bold">{initials}</span>
        </div>
        <div>
          <h1 className="text-xl font-black text-white flex items-center gap-2.5">
            {user.name}
            {!user.active && (
              <span className="text-[11px] font-medium text-red-400 bg-red-500/10 border border-red-500/25 px-2 py-0.5 rounded-full">
                {t('users.inactive')}
              </span>
            )}
          </h1>
          <p className="text-sm text-gray-500">{user.email}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-[#0d1421]/60 rounded-xl p-1 border border-white/[0.06]">
        {TABS.map(({ id: tabId, labelKey, Icon }) => (
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
            {t(labelKey)}
          </button>
        ))}
      </div>

      <div className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-6">
        {tab === 'profile' && <ProfileTab user={user} onUpdated={setUser} />}
        {tab === 'permissions' && <PermissionsTab userId={user.id} userRole={(user.role ?? 'operator') as string} />}
        {tab === 'plants' && <PlantAccessTab userId={user.id} />}
        {tab === 'security' && <SecurityTab user={user} onUpdated={setUser} />}
        {tab === 'activity' && (
          <div className="space-y-2">
            {user.last_login_at ? (
              <div className="text-sm text-gray-400">
                {t('users.lastLoginLabel')} <span className="text-gray-300">{new Date(user.last_login_at).toLocaleString()}</span>
              </div>
            ) : (
              <p className="text-gray-600 text-sm">{t('users.noActivity')}</p>
            )}
            {user.invited_at && (
              <div className="text-sm text-gray-400">
                {t('users.joinedVia')} <span className="text-gray-300">{new Date(user.invited_at).toLocaleString()}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
