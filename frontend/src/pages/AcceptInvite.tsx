import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Factory, User, Lock, Globe, ChevronDown, AlertCircle, CheckCircle } from 'lucide-react';
import { getInvitation, acceptInvite } from '../api/auth';
import i18n from '../i18n';

const LANGUAGES = [
  { code: 'en', label: 'EN', name: 'English' },
  { code: 'fr', label: 'FR', name: 'Français' },
  { code: 'es', label: 'ES', name: 'Español' },
];

export default function AcceptInvite() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const [invitation, setInvitation] = useState<{ email: string; role: string } | null>(null);
  const [inviteError, setInviteError] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [lang, setLang] = useState('en');
  const [langOpen, setLangOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) { setInviteError(t('auth.noInviteToken')); return; }
    getInvitation(token)
      .then(setInvitation)
      .catch(() => setInviteError(t('auth.inviteInvalid')));
  }, [token, t]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) { setError(t('auth.passwordsNoMatch')); return; }
    if (password.length < 8) { setError(t('auth.passwordMinLength')); return; }
    setError('');
    setLoading(true);
    try {
      await acceptInvite({ token, name, password, language: lang });
      setDone(true);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg ?? t('auth.createAccountFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0f1a] flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="bg-[#0d1421]/90 border border-white/[0.08] rounded-2xl p-8 shadow-2xl">
          <div className="flex items-center gap-3.5 mb-8">
            <div className="w-11 h-11 rounded-xl bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-600/30 flex-shrink-0">
              <Factory size={22} className="text-white" />
            </div>
            <div>
              <h1 className="text-white font-bold text-lg leading-none">Foliot MES</h1>
              <p className="text-gray-600 text-[11px] mt-1 leading-none">{t('auth.createYourAccount')}</p>
            </div>
          </div>

          {inviteError ? (
            <div className="flex items-start gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
              <AlertCircle size={15} className="text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-red-400 text-sm">{inviteError}</p>
            </div>
          ) : done ? (
            <div className="text-center py-4">
              <CheckCircle size={40} className="text-green-400 mx-auto mb-3" />
              <p className="text-white font-semibold mb-1">{t('auth.accountCreated')}</p>
              <p className="text-gray-500 text-sm mb-5">{t('auth.canNowSignIn')}</p>
              <button onClick={() => navigate('/login')} className="btn-primary w-full justify-center py-2.5 text-sm">
                {t('auth.goToLogin')}
              </button>
            </div>
          ) : !invitation ? (
            <div className="flex justify-center py-8">
              <div className="w-8 h-8 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
            </div>
          ) : (
            <>
              <div className="mb-5 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                <p className="text-blue-300 text-sm font-medium">{invitation.email}</p>
                <p className="text-gray-500 text-xs mt-0.5">
                  {t('auth.invitedAs')} <span className="text-gray-400">{t(`roles.${invitation.role}`, invitation.role)}</span>
                </p>
              </div>

              {error && (
                <div className="mb-4 flex items-start gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
                  <AlertCircle size={15} className="text-red-400 flex-shrink-0 mt-0.5" />
                  <p className="text-red-400 text-sm">{error}</p>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="label">{t('auth.fullName')}</label>
                  <div className="relative">
                    <User size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={t('auth.yourFullName')}
                      className="input-field pl-9"
                      required
                      disabled={loading}
                    />
                  </div>
                </div>
                <div>
                  <label className="label">{t('auth.password')}</label>
                  <div className="relative">
                    <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={t('auth.minChars')}
                      className="input-field pl-9"
                      required
                      disabled={loading}
                    />
                  </div>
                </div>
                <div>
                  <label className="label">{t('auth.confirmPassword')}</label>
                  <div className="relative">
                    <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
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
                <div>
                  <label className="label">{t('auth.language')}</label>
                  <div className="relative inline-block w-full">
                    <button
                      type="button"
                      onClick={() => setLangOpen((v) => !v)}
                      className="w-full flex items-center gap-2 px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white"
                    >
                      <Globe size={14} className="text-gray-400" />
                      <span className="flex-1 text-left">
                        {LANGUAGES.find((l) => l.code === lang)?.name}
                      </span>
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
                            {l.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading || !name || !password || !confirmPassword}
                  className="btn-primary w-full justify-center py-2.5 mt-1 text-sm"
                >
                  {loading ? (
                    <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  ) : (
                    t('auth.createAccount')
                  )}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
