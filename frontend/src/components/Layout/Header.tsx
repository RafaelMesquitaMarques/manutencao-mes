import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate, Link } from 'react-router-dom';
import { Menu, Globe, ChevronDown, LogOut, User as UserIcon, Lock, Shield, Factory } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { usePlantStore } from '../../store/plantStore';
import { updateMe } from '../../api/auth';
import type { UserRole } from '../../types';
import i18n from '../../i18n';

const LANGUAGES = [
  { code: 'en', label: 'EN', name: 'English' },
  { code: 'fr', label: 'FR', name: 'Français' },
  { code: 'es', label: 'ES', name: 'Español' },
];

const ROLE_LABELS: Record<UserRole, string> = {
  operator: 'Operator',
  technician: 'Technician',
  supervisor: 'Supervisor',
  maintenance_director: 'Maint. Director',
  plant_manager: 'Plant Manager',
  director: 'Director',
  admin: 'Administrator',
};

const ROLE_COLORS: Record<UserRole, string> = {
  operator: 'text-gray-400',
  technician: 'text-blue-400',
  supervisor: 'text-purple-400',
  maintenance_director: 'text-amber-400',
  plant_manager: 'text-green-400',
  director: 'text-cyan-400',
  admin: 'text-red-400',
};

interface HeaderProps {
  onMenuToggle: () => void;
}

interface MenuPos {
  top: number;
  right: number;
}

const Header = ({ onMenuToggle }: HeaderProps) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const memberships = usePlantStore((s) => s.memberships);
  const activePlantId = usePlantStore((s) => s.activePlantId);
  const setActivePlant = usePlantStore((s) => s.setActivePlant);

  const [langOpen, setLangOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [plantOpen, setPlantOpen] = useState(false);
  const [langPos, setLangPos] = useState<MenuPos>({ top: 0, right: 0 });
  const [userPos, setUserPos] = useState<MenuPos>({ top: 0, right: 0 });
  const [plantPos, setPlantPos] = useState<MenuPos>({ top: 0, right: 0 });

  const langBtnRef = useRef<HTMLButtonElement>(null);
  const userBtnRef = useRef<HTMLButtonElement>(null);
  const plantBtnRef = useRef<HTMLButtonElement>(null);
  const langMenuRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const plantMenuRef = useRef<HTMLDivElement>(null);

  const activePlant = memberships.find((m) => m.plant_id === activePlantId) ?? memberships[0];

  const currentLang = LANGUAGES.find((l) => i18n.language?.startsWith(l.code)) ?? LANGUAGES[0];
  const role = (user?.role ?? 'operator') as UserRole;
  const initials = (user?.name ?? 'U').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  // Anchor a menu under its trigger button. Menus render in a portal on <body>,
  // so they escape the header's (backdrop-blur) stacking context and always sit
  // above page content and modals — logout is never trapped behind the page.
  const posFrom = (el: HTMLElement | null): MenuPos => {
    if (!el) return { top: 56, right: 8 };
    const r = el.getBoundingClientRect();
    return { top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) };
  };

  const toggleLang = () => {
    if (!langOpen) { setLangPos(posFrom(langBtnRef.current)); setUserOpen(false); setPlantOpen(false); }
    setLangOpen((o) => !o);
  };
  const toggleUser = () => {
    if (!userOpen) { setUserPos(posFrom(userBtnRef.current)); setLangOpen(false); setPlantOpen(false); }
    setUserOpen((o) => !o);
  };
  const togglePlant = () => {
    if (!plantOpen) { setPlantPos(posFrom(plantBtnRef.current)); setLangOpen(false); setUserOpen(false); }
    setPlantOpen((o) => !o);
  };

  const handlePlantSwitch = (plantId: string) => {
    setPlantOpen(false);
    if (plantId === activePlant?.plant_id) return;
    setActivePlant(plantId);
    // Full reload: no page state, filters or cached lists survive across plants.
    window.location.reload();
  };

  // Close on outside click (account for the portaled menu living outside the header).
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (langBtnRef.current && !langBtnRef.current.contains(tgt) && (!langMenuRef.current || !langMenuRef.current.contains(tgt))) {
        setLangOpen(false);
      }
      if (userBtnRef.current && !userBtnRef.current.contains(tgt) && (!userMenuRef.current || !userMenuRef.current.contains(tgt))) {
        setUserOpen(false);
      }
      if (plantBtnRef.current && !plantBtnRef.current.contains(tgt) && (!plantMenuRef.current || !plantMenuRef.current.contains(tgt))) {
        setPlantOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Keep menus anchored to their button if the viewport changes while open.
  useEffect(() => {
    if (!langOpen && !userOpen && !plantOpen) return;
    const update = () => {
      if (langOpen) setLangPos(posFrom(langBtnRef.current));
      if (userOpen) setUserPos(posFrom(userBtnRef.current));
      if (plantOpen) setPlantPos(posFrom(plantBtnRef.current));
    };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [langOpen, userOpen, plantOpen]);

  const handleLogout = () => {
    setUserOpen(false);
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
        {/* Active plant — selector only when the user may switch (>1 membership) */}
        {activePlant && (memberships.length > 1 ? (
          <button
            ref={plantBtnRef}
            onClick={togglePlant}
            title={t('plants.switchPlant')}
            className="flex items-center gap-1.5 text-gray-400 hover:text-gray-200 text-sm
                       bg-white/[0.04] hover:bg-white/[0.07] border border-white/[0.08]
                       px-2.5 py-1.5 rounded-lg transition-all duration-150"
          >
            <Factory size={14} className="text-blue-400" />
            <span className="text-xs font-medium max-w-[150px] truncate hidden sm:block">{activePlant.name}</span>
            <span className="font-mono font-semibold text-xs sm:hidden">{activePlant.code}</span>
            <ChevronDown size={12} className={`transition-transform ${plantOpen ? 'rotate-180' : ''}`} />
          </button>
        ) : (
          <div
            title={t('plants.activePlant')}
            className="flex items-center gap-1.5 text-gray-400 text-sm
                       bg-white/[0.04] border border-white/[0.08] px-2.5 py-1.5 rounded-lg"
          >
            <Factory size={14} className="text-blue-400" />
            <span className="text-xs font-medium max-w-[150px] truncate hidden sm:block">{activePlant.name}</span>
            <span className="font-mono font-semibold text-xs sm:hidden">{activePlant.code}</span>
          </div>
        ))}

        {plantOpen && createPortal(
          <div
            ref={plantMenuRef}
            style={{ position: 'fixed', top: plantPos.top, right: plantPos.right, zIndex: 200 }}
            className="w-64 bg-[#111827] border border-white/10 rounded-xl shadow-2xl overflow-hidden animate-slide-in"
          >
            <div className="px-3 py-2 border-b border-white/[0.06] text-[10px] uppercase tracking-wider text-gray-500">
              {t('plants.switchPlant')}
            </div>
            {memberships.map((m) => (
              <button
                key={m.plant_id}
                onClick={() => handlePlantSwitch(m.plant_id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm transition-colors
                  ${m.plant_id === activePlant?.plant_id
                    ? 'text-blue-400 bg-blue-500/10'
                    : 'text-gray-300 hover:text-white hover:bg-white/[0.05]'
                  }`}
              >
                <Factory size={14} className="shrink-0" />
                <span className="flex-1 text-left truncate">{m.name}</span>
                <span className="font-mono text-[10px] text-gray-500">{m.code}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}

        {/* Language switcher */}
        <button
          ref={langBtnRef}
          onClick={toggleLang}
          className="flex items-center gap-1.5 text-gray-400 hover:text-gray-200 text-sm
                     bg-white/[0.04] hover:bg-white/[0.07] border border-white/[0.08]
                     px-2.5 py-1.5 rounded-lg transition-all duration-150"
        >
          <Globe size={14} />
          <span className="font-mono font-semibold text-xs">{currentLang.label}</span>
          <ChevronDown size={12} className={`transition-transform ${langOpen ? 'rotate-180' : ''}`} />
        </button>

        {langOpen && createPortal(
          <div
            ref={langMenuRef}
            style={{ position: 'fixed', top: langPos.top, right: langPos.right, zIndex: 200 }}
            className="w-36 bg-[#111827] border border-white/10 rounded-xl shadow-2xl overflow-hidden animate-slide-in"
          >
            {LANGUAGES.map((lang) => (
              <button
                key={lang.code}
                onClick={() => {
                  i18n.changeLanguage(lang.code);
                  updateMe({ language: lang.code }).catch(() => {});
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
          </div>,
          document.body,
        )}

        {/* User menu */}
        <button
          ref={userBtnRef}
          onClick={toggleUser}
          className="flex items-center gap-2 text-gray-400 hover:text-gray-200
                     bg-white/[0.04] hover:bg-white/[0.07] border border-white/[0.08]
                     pl-2 pr-3 py-1.5 rounded-lg transition-all duration-150"
        >
          <div className="w-6 h-6 rounded-full bg-blue-600/30 border border-blue-500/30 flex items-center justify-center text-blue-400 font-bold text-[10px]">
            {initials}
          </div>
          <span className="text-sm font-medium text-gray-300 hidden sm:block max-w-[120px] truncate">
            {user?.name ?? user?.email ?? 'User'}
          </span>
          <ChevronDown size={12} className={`transition-transform hidden sm:block ${userOpen ? 'rotate-180' : ''}`} />
        </button>

        {userOpen && createPortal(
          <div
            ref={userMenuRef}
            style={{ position: 'fixed', top: userPos.top, right: userPos.right, zIndex: 200 }}
            className="w-52 bg-[#111827] border border-white/10 rounded-xl shadow-2xl overflow-hidden animate-slide-in"
          >
            <div className="px-3 py-2.5 border-b border-white/[0.06]">
              <p className="text-white text-sm font-medium truncate">{user?.name}</p>
              <p className="text-gray-500 text-xs truncate mt-0.5">{user?.email}</p>
              {user?.role && (
                <span className={`text-[10px] font-medium mt-1 inline-block ${ROLE_COLORS[role]}`}>
                  {ROLE_LABELS[role]}
                </span>
              )}
            </div>
            <Link
              to="/settings/profile"
              onClick={() => setUserOpen(false)}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-gray-300 hover:text-white hover:bg-white/[0.05] transition-colors"
            >
              <UserIcon size={14} />
              My Profile
            </Link>
            <Link
              to="/settings/change-password"
              onClick={() => setUserOpen(false)}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-gray-300 hover:text-white hover:bg-white/[0.05] transition-colors"
            >
              <Lock size={14} />
              Change Password
            </Link>
            {user?.role === 'admin' && (
              <Link
                to="/settings/users"
                onClick={() => setUserOpen(false)}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-gray-300 hover:text-white hover:bg-white/[0.05] transition-colors"
              >
                <Shield size={14} />
                User Management
              </Link>
            )}
            <div className="border-t border-white/[0.06]">
              <button
                onClick={handleLogout}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/5 transition-colors"
              >
                <LogOut size={14} />
                {t('nav.logout')}
              </button>
            </div>
          </div>,
          document.body,
        )}
      </div>
    </header>
  );
};

export default Header;
