import { lazy, Suspense } from 'react';
import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { House, Inbox, Library, ListVideo, LogOut, Plug, Settings as SettingsIcon } from 'lucide-react';
import { get, post } from './lib/api';
import { useAppearance, useMe, useUser } from './lib/session';
import { CenterLoading } from './components/ui';
import { LoginPage, SetupPage } from './pages/Auth';
import { HomePage } from './pages/Home';
import { WatchlistsPage } from './pages/Watchlists';
import { TitlePage } from './pages/Title';

const RequestsPage = lazy(() => import('./pages/Requests').then((m) => ({ default: m.RequestsPage })));
const LibraryPage = lazy(() => import('./pages/Library').then((m) => ({ default: m.LibraryPage })));
const IntegrationsPage = lazy(() => import('./pages/Integrations').then((m) => ({ default: m.IntegrationsPage })));
const IntegrationDetail = lazy(() => import('./pages/IntegrationDetail').then((m) => ({ default: m.IntegrationDetail })));
const SourceDetail = lazy(() => import('./pages/IntegrationDetail').then((m) => ({ default: m.SourceDetail })));
const SettingsPage = lazy(() => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })));

export function App() {
  const me = useMe();
  useAppearance(me.data?.user?.preferences.appearance);
  if (me.isLoading) return <CenterLoading label="Starting JellyWatcher" />;
  if (me.isError || !me.data) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <h1 className="title-2">JellyWatcher is unavailable</h1>
          <p className="lede">The server could not be reached. Check that the container is running, then reload.</p>
          <button className="btn btn-primary btn-large" style={{ width: '100%' }} onClick={() => me.refetch()}>
            Try Again
          </button>
        </div>
      </div>
    );
  }
  if (me.data.needsSetup) return <SetupPage />;
  if (!me.data.user) return <LoginPage me={me.data} />;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<HomePage />} />
        <Route path="watchlists/*" element={<WatchlistsPage />} />
        <Route path="titles/:id" element={<TitlePage />} />
        <Route path="requests" element={<RequestsPage />} />
        <Route path="library" element={<LibraryPage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="integrations/:provider" element={<IntegrationDetail />} />
        <Route path="integrations/sources/:source" element={<SourceDetail />} />
        <Route path="settings/*" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

const PRIMARY_NAV = [
  { to: '/', label: 'Home', icon: House, end: true },
  { to: '/watchlists', label: 'Watchlists', icon: ListVideo },
  { to: '/requests', label: 'Requests', icon: Inbox },
  { to: '/library', label: 'Library', icon: Library },
];

function Shell() {
  const { user, isAdmin } = useUser();
  const location = useLocation();
  const review = useQuery({ queryKey: ['home'], queryFn: () => get<{ counts: { review: number } }>('/home'), staleTime: 60_000 });
  const reviewCount = review.data?.counts.review ?? 0;

  const signOut = async () => {
    await post('/auth/logout').catch(() => undefined);
    // A full navigation drops all cached data from the previous session.
    window.location.assign('/');
  };
  const initials = user.displayName
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <nav className="sidebar" aria-label="Main">
        <NavLink to="/" className="brand" aria-label="JellyWatcher home">
          <img className="brand-mark" src="/logo.png" alt="" aria-hidden />
          JellyWatcher
        </NavLink>
        {PRIMARY_NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className="nav-item">
            <Icon size={18} aria-hidden />
            {label}
            {to === '/watchlists' && reviewCount > 0 && (
              <span className="badge-count" aria-label={`${reviewCount} need review`}>
                {reviewCount > 99 ? '99+' : reviewCount}
              </span>
            )}
          </NavLink>
        ))}
        <div className="nav-section">Manage</div>
        <NavLink to="/integrations" className="nav-item">
          <Plug size={18} aria-hidden />
          Integrations
        </NavLink>
        <NavLink to="/settings" className="nav-item">
          <SettingsIcon size={18} aria-hidden />
          Settings
        </NavLink>
        <div className="sidebar-footer">
          <span className="avatar" aria-hidden>
            {initials}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="subhead" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user.displayName}
            </div>
            <div className="caption secondary">{isAdmin ? 'Administrator' : 'Member'}</div>
          </div>
          <button className="icon-btn" onClick={signOut} aria-label="Sign out" title="Sign out">
            <LogOut size={17} />
          </button>
        </div>
      </nav>

      <div className="mobile-top">
        <NavLink to="/" className="brand" style={{ padding: 0 }} aria-label="JellyWatcher home">
          <img className="brand-mark" src="/logo.png" alt="" aria-hidden />
          JellyWatcher
        </NavLink>
        <div className="toolbar" style={{ gap: 0 }}>
          <NavLink to="/integrations" className="icon-btn" aria-label="Integrations">
            <Plug size={20} />
          </NavLink>
          <NavLink to="/settings" className="icon-btn" aria-label="Settings">
            <SettingsIcon size={20} />
          </NavLink>
          <button className="icon-btn" onClick={signOut} aria-label="Sign out" title="Sign out">
            <LogOut size={19} />
          </button>
        </div>
      </div>

      <main className="main" id="main" tabIndex={-1}>
        <div className="main-inner" key={location.pathname.split('/')[1]}>
          <Suspense fallback={<CenterLoading />}>
            <Outlet />
          </Suspense>
        </div>
      </main>

      <nav className="tabbar" aria-label="Main">
        {PRIMARY_NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className="tab">
            <Icon size={22} aria-hidden />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
