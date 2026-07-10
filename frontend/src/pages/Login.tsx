import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Mail, Lock, Globe, ChevronDown, AlertCircle } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { usePlantStore } from '../store/plantStore';
import { login } from '../api/auth';
import type { User } from '../types';
import i18n from '../i18n';

const LANGUAGES = [
  { code: 'en', label: 'EN', name: 'English' },
  { code: 'fr', label: 'FR', name: 'Français' },
  { code: 'es', label: 'ES', name: 'Español' },
];

const Login = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { setAuth, isAuthenticated } = useAuthStore();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [langOpen, setLangOpen] = useState(false);

  const currentLang = LANGUAGES.find((l) => i18n.language?.startsWith(l.code)) ?? LANGUAGES[0];

  useEffect(() => {
    if (isAuthenticated) navigate('/dashboard', { replace: true });
  }, [isAuthenticated, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    try {
      const result = await login({ email, password });
      const user: User = {
        id: String(result.user_id),
        email,
        name: result.name,
        active: true,
        role: result.role,
        language: result.language,
        must_change_password: result.must_change_password,
      };
      usePlantStore.getState().setMemberships(result.plants ?? [], result.default_plant_id ?? null);
      setAuth(user, result.access_token);
      navigate(result.must_change_password ? '/force-change-password' : '/dashboard', { replace: true });
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      setError(status === 401 ? t('auth.invalidCredentials') : t('auth.loginError'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0f1a] flex flex-col items-center justify-center p-4 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-blue-600/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 right-0 w-[400px] h-[300px] bg-blue-900/10 rounded-full blur-3xl pointer-events-none" />

      {/* Language switcher */}
      <div className="w-full max-w-sm flex justify-end mb-5 relative z-10">
        <div className="relative">
          <button
            onClick={() => setLangOpen(!langOpen)}
            className="flex items-center gap-1.5 text-gray-400 hover:text-gray-200 text-sm
                       bg-white/[0.04] hover:bg-white/[0.07] border border-white/[0.08]
                       px-3 py-1.5 rounded-lg transition-all"
          >
            <Globe size={14} />
            <span className="font-mono font-semibold text-xs">{currentLang.label}</span>
            <ChevronDown size={12} className={`transition-transform ${langOpen ? 'rotate-180' : ''}`} />
          </button>
          {langOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-36 bg-[#111827] border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden animate-slide-in">
              {LANGUAGES.map((lang) => (
                <button
                  key={lang.code}
                  onClick={() => { i18n.changeLanguage(lang.code); setLangOpen(false); }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm transition-colors
                    ${currentLang.code === lang.code
                      ? 'text-blue-400 bg-blue-500/10'
                      : 'text-gray-300 hover:text-white hover:bg-white/[0.05]'
                    }`}
                >
                  <span className="font-mono font-semibold text-xs w-5">{lang.label}</span>
                  <span className="text-gray-500 text-xs">{lang.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Card */}
      <div className="w-full max-w-sm relative z-10">
        <div className="bg-[#0d1421]/90 backdrop-blur-sm border border-white/[0.08] rounded-2xl p-8 shadow-2xl">
          {/* Brand */}
          <div className="flex items-center gap-3.5 mb-8">
            <img src="/mirai-icon.png" alt="" className="w-12 h-12 object-contain flex-shrink-0" />
            <div>
              <p className="text-gray-400 text-[11px] mt-1.5 leading-none">Manufacturing Execution System</p>
            </div>
          </div>

          <div className="mb-6">
            <h2 className="text-white text-xl font-semibold">{t('auth.welcomeBack')}</h2>
            <p className="text-gray-500 text-sm mt-1">{t('auth.signInSubtitle')}</p>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-5 flex items-start gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
              <AlertCircle size={15} className="text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">{t('auth.email')}</label>
              <div className="relative">
                <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('auth.emailPlaceholder')}
                  className="input-field pl-9"
                  autoComplete="email"
                  required
                  disabled={isLoading}
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
                  placeholder={t('auth.passwordPlaceholder')}
                  className="input-field pl-9"
                  autoComplete="current-password"
                  required
                  disabled={isLoading}
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading || !email || !password}
              className="btn-primary w-full justify-center py-2.5 mt-1 text-sm"
            >
              {isLoading ? (
                <>
                  <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  {t('auth.signingIn')}
                </>
              ) : (
                t('auth.signIn')
              )}
            </button>
          </form>
        </div>

        <p className="text-center text-gray-700 text-xs mt-5 font-mono">
          © {new Date().getFullYear()} Foliot Furniture Inc.
        </p>
      </div>
    </div>
  );
};

export default Login;
