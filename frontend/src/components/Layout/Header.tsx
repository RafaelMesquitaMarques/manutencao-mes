import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Menu, Globe, ChevronDown, LogOut, User as UserIcon } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import i18n from '../../i18n';

const LANGUAGES = [
  { code: 'en', label: 'EN', name: 'English' },
  { code: 'fr', label: 'FR', name: 'Français' },
  { code: 'es', label: 'ES', name: 'Español' },
];

interface HeaderProps {
  onMenuToggle: () => void;
}

const Header = ({ onMenuToggle }: HeaderProps) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();

  const [langOpen, setLangOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const langRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLDivElement>(null);

  const currentLang = LANGUAGES.find((l) => i18n.language?.startsWith(l.code)) ?? LANGUAGES[0];

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (langRef.current && !langRef.current.contains(e.target as Node)) setLangOpen(false);
      if (userRef.current && !userRef.current.contains(e.target as Node)) setUserOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <header className="h-14 flex items-center justify-between px-4 border-b border-white/[0.06] bg-[#0a0f1a]/80 backdrop-blur-sm flex-shrink-0">
      {/* Left */}
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuToggle}
          className="lg:hidden text-gray-400 hover:text-gray-200 transition-colors p-1.5 rounded-lg hover:bg-white/5"
          aria-label="Toggle menu"
        >
          <Menu size={20} />
        </button>
      </div>

      {/* Right */}
      <div className="flex items-center gap-2">
        {/* Language switcher */}
        <div ref={langRef} className="relative">
          <button
            onClick={() => setLangOpen(!langOpen)}
            className="flex items-center gap-1.5 text-gray-400 hover:text-gray-200 text-sm
                       bg-white/[0.04] hover:bg-white/[0.07] border border-white/[0.08]
                       px-2.5 py-1.5 rounded-lg transition-all duration-150"
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
                  onClick={() => {
                    i18n.changeLanguage(lang.code);
                    setLangOpen(false);
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm transition-colors
                    ${currentLang.code === lang.code
                      ? 'text-blue-400 bg-blue-500/10'
                      : 'text-gray-300 hover:text-white hover:bg-white/[0.05]'
                    }`}
                >
                  <span className="font-mono font-semibold text-xs w-5">{lang.label}</span>
                  <span className="text-gray-400 text-xs">{lang.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* User menu */}
        <div ref={userRef} className="relative">
          <button
            onClick={() => setUserOpen(!userOpen)}
            className="flex items-center gap-2 text-gray-400 hover:text-gray-200
                       bg-white/[0.04] hover:bg-white/[0.07] border border-white/[0.08]
                       pl-2 pr-3 py-1.5 rounded-lg transition-all duration-150"
          >
            <div className="w-6 h-6 rounded-full bg-blue-600/30 border border-blue-500/30 flex items-center justify-center">
              <UserIcon size={12} className="text-blue-400" />
            </div>
            <span className="text-sm font-medium text-gray-300 hidden sm:block max-w-[120px] truncate">
              {user?.full_name ?? user?.email ?? 'User'}
            </span>
            <ChevronDown size={12} className={`transition-transform hidden sm:block ${userOpen ? 'rotate-180' : ''}`} />
          </button>

          {userOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-48 bg-[#111827] border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden animate-slide-in">
              <div className="px-3 py-2.5 border-b border-white/[0.06]">
                <p className="text-white text-sm font-medium truncate">{user?.full_name}</p>
                <p className="text-gray-500 text-xs truncate mt-0.5">{user?.email}</p>
              </div>
              <button
                onClick={handleLogout}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/5 transition-colors"
              >
                <LogOut size={14} />
                {t('nav.logout')}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

export default Header;
