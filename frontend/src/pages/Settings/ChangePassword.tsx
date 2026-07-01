import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, CheckCircle, AlertCircle } from 'lucide-react';
import { changePassword } from '../../api/auth';

export default function ChangePassword() {
  const { t } = useTranslation();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) { setError(t('settings.passwordsNoMatch')); return; }
    if (newPassword.length < 8) { setError(t('settings.passwordMin8')); return; }
    setError('');
    setLoading(true);
    try {
      await changePassword(oldPassword, newPassword);
      setSuccess(true);
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? t('settings.changePasswordFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#060c17] text-white p-6 max-w-lg mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-black text-white">{t('settings.changePasswordTitle')}</h1>
        <p className="text-sm text-gray-600 mt-1">{t('settings.changePasswordSubtitle')}</p>
      </div>

      <div className="bg-[#0d1421] rounded-2xl border border-white/[0.06] p-6">
        {success && (
          <div className="mb-5 flex items-center gap-2.5 p-3 bg-green-500/10 border border-green-500/25 rounded-lg">
            <CheckCircle size={15} className="text-green-400 flex-shrink-0" />
            <p className="text-green-400 text-sm">{t('settings.passwordChanged')}</p>
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
            <label className="label">{t('settings.currentPassword')}</label>
            <div className="relative">
              <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
              <input
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                className="input-field pl-9"
                required
                disabled={loading}
              />
            </div>
          </div>
          <div>
            <label className="label">{t('settings.newPassword')}</label>
            <div className="relative">
              <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={t('settings.min8chars')}
                className="input-field pl-9"
                required
                disabled={loading}
              />
            </div>
          </div>
          <div>
            <label className="label">{t('settings.confirmNewPassword')}</label>
            <div className="relative">
              <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                className="input-field pl-9"
                required
                disabled={loading}
              />
            </div>
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={loading || !oldPassword || !newPassword || !confirmPassword}
              className="btn-primary py-2.5 px-6 text-sm"
            >
              {loading ? (
                <>
                  <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  {t('settings.updating')}
                </>
              ) : (
                t('settings.updatePassword')
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
