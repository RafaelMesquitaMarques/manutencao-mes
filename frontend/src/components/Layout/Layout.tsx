import { useState, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';

// Board-style pages with their own wide canvas use the full width instead of the
// centered max-width column (which otherwise wastes the side margins on large screens).
// Wide data-grid list pages use the full screen width. Exact match so their
// detail/new sub-pages (/equipment/:id, /work-orders/new…) keep the centered,
// readable max-width column.
const FULL_BLEED_EXACT = ['/inventory', '/work-orders', '/equipment', '/suppliers', '/supplier-orders', '/factory-map'];
const FULL_BLEED_PREFIXES = ['/schedule'];

const Layout = () => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { pathname } = useLocation();
  const fullBleed =
    FULL_BLEED_EXACT.includes(pathname) ||
    FULL_BLEED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  // Close sidebar on larger screens resize
  useEffect(() => {
    const handler = () => {
      if (window.innerWidth >= 1024) setSidebarOpen(false);
    };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-[#0a0f1a]">
      {/* Desktop Sidebar */}
      <div className="hidden lg:flex flex-shrink-0">
        <Sidebar />
      </div>

      {/* Mobile Sidebar Drawer */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="relative z-50 flex-shrink-0 animate-slide-in">
            <Sidebar onClose={() => setSidebarOpen(false)} />
          </div>
        </div>
      )}

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header onMenuToggle={() => setSidebarOpen(!sidebarOpen)} />
        {/* All pages use the full screen width. `fullBleed` pages (wide data grids,
            board views) manage their own padding; everything else gets the standard
            page padding here. Narrow forms self-constrain via their own max-w. */}
        <main className={`flex-1 overflow-y-auto ${fullBleed ? '' : 'p-4 md:p-6'}`}>
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default Layout;
