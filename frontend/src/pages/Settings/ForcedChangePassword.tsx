import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Lock, Eye, EyeOff, AlertCircle, Factory, Smile } from 'lucide-react';
import { forcedChangePassword, updateMe } from '../../api/auth';
import { useAuthStore } from '../../store/authStore';
import type { User } from '../../types';

export default function ForcedChangePassword() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, patchUser } = useAuthStore();
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [nickname, setNickname] = useState(user?.nickname ?? '');
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const firstName = (user?.name ?? '').trim().split(/\s+/)[0] || '';

  const mismatch = confirm.length > 0 && newPassword !== confirm;
  const canSubmit = newPassword.length >= 8 && newPassword === confirm;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError('');
    setLoading(true);
    try {
      await forcedChangePassword(newPassword);
      const patch: Partial<User> = { must_change_password: false };
      // Save the greeting name alongside — best-effort: the password change is the
      // gate here, a nickname hiccup must not lock the user on this screen.
      const wanted = nickname.trim();
      if (wanted !== (user?.nickname ?? '')) {
        try {
          const updated = await updateMe({ nickname: wanted });
          patch.nickname = updated.nickname ?? null;
        } catch { /* can still be set later in User Management */ }
      }
      patchUser(patch);
      navigate('/dashboard', { replace: true });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? t('settings.updatePasswordFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0f1a] flex flex-col items-center justify-center p-4">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-blue-600/5 rounded-full blur-3xl pointer-events-none" />

      <div className="w-full max-w-sm relative z-10">
        <div className="bg-[#0d1421]/90 backdrop-blur-sm border border-white/[0.08] rounded-2xl p-8 shadow-2xl">
          <div className="flex items-center gap-3.5 mb-6">
            <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-600/30 flex-shrink-0">
              <Factory size={20} className="text-white" />
            </div>
            <div>
              <h1 className="text-white font-bold text-base leading-none">Foliot MES</h1>
              <p className="text-gray-600 text-[11px] mt-0.5 leading-none">{t('settings.appSubtitle')}</p>
            </div>
          </div>

          <div className="mb-5 p-3 bg-amber-500/10 border border-amber-500/25 rounded-lg">
            <p className="text-amber-400 text-sm font-medium">{t('settings.forcedTitle')}</p>
            <p className="text-amber-400/70 text-xs mt-0.5">
              {user?.name
                ? t('settings.forcedDescGreeting', { name: user.name.split(' ')[0] })
                : t('settings.forcedDescNoName')}
            </p>
          </div>

          {error && (
            <div className="mb-4 flex items-start gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
              <AlertCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">{t('settings.newPassword')}</label>
              <div className="relative">
                <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
                <input
                  type={showNew ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder={t('settings.min8chars')}
                  className="input-field pl-9 pr-10"
                  autoFocus
                  required
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() => setShowNew((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                  tabIndex={-1}
                >
                  {showNew ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              {newPassword.length > 0 && newPassword.length < 8 && (
                <p className="text-red-400 text-xs mt-1">{t('settings.mustBe8')}</p>
              )}
            </div>

            <div>
              <label className="label">{t('settings.confirmNewPassword')}</label>
              <div className="relative">
                <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
                <input
                  type={showConfirm ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder={t('settings.repeatPassword')}
                  className="input-field pl-9 pr-10"
                  required
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                  tabIndex={-1}
                >
                  {showConfirm ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              {mismatch && <p className="text-red-400 text-xs mt-1">{t('settings.passwordsDoNotMatch')}</p>}
            </div>

            <div>
              <label className="label">
                {t('settings.nicknameQuestion')}{' '}
                <span className="text-gray-600 normal-case">({t('users.optional')})</span>
              </label>
              <div className="relative">
                <Smile size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
                <input
                  type="text"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder={firstName}
                  maxLength={100}
                  className="input-field pl-9"
                  disabled={loading}
                />
              </div>
              <p className="text-[11px] text-gray-600 mt-1">{t('settings.nicknameSelfHint')}</p>
            </div>

            <button
              type="submit"
              disabled={loading || !canSubmit}
              className="btn-primary w-full justify-center py-2.5 text-sm mt-1"
            >
              {loading ? (
                <>
                  <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  {t('settings.updating')}
                </>
              ) : (
                t('settings.setNewPassword')
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
