import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { User, Phone, Briefcase, Globe, ChevronDown, CheckCircle, AlertCircle, Lock, Thermometer } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { updateMe } from '../../api/auth';
import type { UserRole } from '../../types';

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
];

const ROLE_COLORS: Record<UserRole, string> = {
  operator: 'text-gray-400 bg-gray-500/15 border-gray-600/30',
  technician: 'text-blue-400 bg-blue-500/15 border-blue-500/30',
  supervisor: 'text-purple-400 bg-purple-500/15 border-purple-500/30',
  maintenance_director: 'text-amber-400 bg-amber-500/15 border-amber-500/30',
  plant_manager: 'text-green-400 bg-green-500/15 border-green-500/30',
  director: 'text-cyan-400 bg-cyan-500/15 border-cyan-500/30',
  admin: 'text-red-400 bg-red-500/15 border-red-500/30',
};

export default function MyProfile() {
  const { t } = useTranslation();
  const { user, setAuth, token } = useAuthStore();
  const [name, setName] = useState(user?.name ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [lang, setLang] = useState(user?.language ?? 'en');
  const [langOpen, setLangOpen] = useState(false);
  const [tempUnit, setTempUnit] = useState<'C' | 'F'>(user?.temp_unit ?? 'C');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const role = (user?.role ?? 'operator') as UserRole;
  const initials = (user?.name ?? 'U').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess(false);
    setLoading(true);
    try {
      const updated = await updateMe({ name, phone, language: lang, temp_unit: tempUnit });
      if (user && token) {
        setAuth({ ...user, ...updated }, token);
      }
      setSuccess(true);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? t('settings.updateProfileFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#060c17] text-white p-6 max-w-xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-black text-white">{t('settings.profileTitle')}</h1>
        <p className="text-sm text-gray-600 mt-1">{t('settings.profileSubtitle')}</p>
      </div>

      {/* Avatar & role */}
      <div className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-6 mb-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center flex-shrink-0">
            <span className="text-blue-400 font-bold text-lg">{initials}</span>
          </div>
          <div>
            <p className="text-white font-semibold text-base">{user?.name}</p>
            <p className="text-gray-500 text-sm">{user?.email}</p>
            <span className={`inline-flex mt-1 items-center px-2 py-0.5 rounded-full border text-xs font-medium ${ROLE_COLORS[role]}`}>
              {t(`roles.${role}`)}
            </span>
          </div>
        </div>
      </div>

      {/* Edit form */}
      <div className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-6">
        {success && (
          <div className="mb-5 flex items-center gap-2.5 p-3 bg-green-500/10 border border-green-500/25 rounded-lg">
            <CheckCircle size={15} className="text-green-400 flex-shrink-0" />
            <p className="text-green-400 text-sm">{t('settings.profileUpdated')}</p>
          </div>
        )}
        {error && (
          <div className="mb-5 flex items-start gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
            <AlertCircle size={15} className="text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-red-400 text-sm">{error}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">{t('settings.fullName')}</label>
            <div className="relative">
              <User size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input-field pl-9"
                required
                disabled={loading}
              />
            </div>
          </div>
          <div>
            <label className="label">{t('settings.phone')}</label>
            <div className="relative">
              <Phone size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 (555) 000-0000"
                className="input-field pl-9"
                disabled={loading}
              />
            </div>
          </div>
          <div>
            <label className="label">{t('settings.language')}</label>
            <div className="relative">
              <Globe size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none z-10" />
              <button
                type="button"
                onClick={() => setLangOpen((v) => !v)}
                className="input-field pl-9 w-full text-left flex items-center justify-between"
              >
                <span>{LANGUAGES.find((l) => l.code === lang)?.label ?? lang}</span>
                <ChevronDown size={12} className="text-gray-400" />
              </button>
              {langOpen && (
                <div className="absolute z-50 w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg overflow-hidden">
                  {LANGUAGES.map((l) => (
                    <button
                      key={l.code}
                      type="button"
                      onClick={() => { setLang(l.code); setLangOpen(false); }}
                      className={`w-full text-left px-3 py-2.5 text-sm transition-colors ${
                        lang === l.code ? 'text-blue-400 bg-blue-500/10' : 'text-gray-300 hover:bg-white/5'
                      }`}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div>
            <label className="label">{t('settings.temperatureUnit')}</label>
            <div className="relative">
              <Thermometer size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none z-10" />
              <div className="input-field pl-9 flex items-center gap-2">
                {(['C', 'F'] as const).map((u) => (
                  <button
                    key={u}
                    type="button"
                    onClick={() => setTempUnit(u)}
                    className={`px-3 py-1 rounded-md text-sm transition-colors ${
                      tempUnit === u ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40' : 'text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    {u === 'C' ? t('settings.celsius') : t('settings.fahrenheit')}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="pt-2 flex items-center gap-3">
            <button
              type="submit"
              disabled={loading || !name}
              className="btn-primary py-2.5 px-6 text-sm"
            >
              {loading ? (
                <>
                  <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  {t('settings.saving')}
                </>
              ) : (
                t('settings.saveChanges')
              )}
            </button>
            <Link
              to="/settings/change-password"
              className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-white transition-colors"
            >
              <Lock size={13} />
              {t('settings.changePasswordLink')}
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
