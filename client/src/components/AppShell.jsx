import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Bell, LogOut, Menu, Search, KeyRound, X } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { navFor } from '../nav.js';
import { useApi } from '../api/hooks.js';
import { api } from '../api/client.js';
import { ROLE_LABEL, relative } from '../lib/format.js';
import { cx, useToast } from './ui.jsx';

function Sidebar({ onNavigate }) {
  const { user, config } = useAuth();
  const groups = navFor(user);
  return (
    <nav className="flex h-full flex-col bg-ink text-white" aria-label="Main">
      <Link to={user?.role === 'patient' ? '/portal' : '/dashboard'} className="flex items-center gap-2.5 px-5 py-4" onClick={onNavigate}>
        <svg viewBox="0 0 32 32" className="h-8 w-8 shrink-0" aria-hidden><rect width="32" height="32" rx="7" fill="#fff" /><path d="M13 7h6v6h6v6h-6v6h-6v-6H7v-6h6z" fill="#12282F" /><rect x="0" y="26" width="32" height="6" fill="#0B6B5A" /></svg>
        <span className="min-w-0">
          <span className="block font-sign text-lg font-semibold leading-tight">{config?.hospitalName ?? 'Hospital'}</span>
          <span className="block text-xs text-white/60">{user?.role === 'patient' ? 'Patient portal' : 'Hospital Management System'}</span>
        </span>
      </Link>
      <div className="flex-1 overflow-y-auto px-3 pb-6">
        {groups.map((g) => (
          <div key={g.group ?? 'top'} className="mt-4 first:mt-1">
            {g.group && <p className="px-2 pb-1 text-xs font-semibold text-white/50">{g.group}</p>}
            <ul className="space-y-0.5">
              {g.items.map((i) => (
                <li key={i.to}>
                  <NavLink to={i.to} end={i.end ?? i.to === '/dashboard'} onClick={onNavigate} style={{ '--way': `var(--way-${i.way})` }}
                    className={({ isActive }) => cx('flex items-center gap-2.5 rounded px-2.5 py-2 text-sm transition-colors', isActive ? 'way-band bg-white text-ink font-semibold' : 'text-white/85 hover:bg-white/10')}>
                    <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: `var(--way-${i.way})`, boxShadow: '0 0 0 1px rgba(255,255,255,.35)' }} aria-hidden />
                    <i.icon className="h-4 w-4 shrink-0 opacity-80" aria-hidden />
                    <span className="truncate">{i.label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

/** UC-14: look up any patient by ID from anywhere. */
function PatientLookup() {
  const { can } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [code, setCode] = useState('');
  if (!can('patients.view')) return null;
  const submit = async (e) => {
    e.preventDefault();
    if (!code.trim()) return;
    const r = await api(`/patients/verify/${encodeURIComponent(code.trim())}`).catch((err) => ({ valid: false, message: err.message }));
    if (!r.valid) return toast({ tone: 'alert', title: r.message ?? 'Patient not found.' });
    setCode('');
    nav(can('clinical.view') ? `/doctor/patients/${r.patient.id}` : can('billing.manage') ? `/billing/patients/${r.patient.id}` : `/patients/${r.patient.id}`);
  };
  return (
    <form onSubmit={submit} className="relative hidden md:block" role="search">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted" aria-hidden />
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Open patient by ID, e.g. P-2026-000001" aria-label="Patient ID" className="field-input w-80 py-1.5 pl-8 text-sm" />
    </form>
  );
}

function NotificationBell() {
  const q = useApi('/notifications?pageSize=8', { background: true, refetchInterval: 60_000 });
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const unread = q.data?.unreadCount ?? 0;
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="relative rounded p-2 text-ink hover:bg-ink/5" aria-label={`Notifications, ${unread} unread`} aria-expanded={open}>
        <Bell className="h-5 w-5" />
        {unread > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-5 rounded-full bg-alert px-1 text-center text-xs font-bold leading-5 text-white">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[min(92vw,380px)] rounded-panel border border-rule bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-rule px-4 py-2.5">
            <p className="font-sign text-lg font-semibold">Notifications</p>
            <Link to="/notifications" className="link text-sm">See all</Link>
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {(q.data?.data ?? []).length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">You have no notifications.</li>}
            {(q.data?.data ?? []).map((n) => (
              <li key={n.id} className={cx('border-b border-rule/70 px-4 py-2.5 text-sm last:border-0', !n.isRead && 'bg-scrub-light/50')}>
                {n.link ? <Link to={n.link} className="font-semibold hover:underline" onClick={() => api(`/notifications/${n.id}/read`, { method: 'POST' }).then(() => q.refetch())}>{n.title}</Link> : <p className="font-semibold">{n.title}</p>}
                <p className="text-muted">{n.message}</p>
                <p className="mt-0.5 text-xs text-muted">{relative(n.createdAt)}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const initials = user.fullName.replace(/^Dr\.\s*/, '').split(' ').map((s) => s[0]).slice(0, 2).join('');
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded py-1 pl-1 pr-2 hover:bg-ink/5" aria-expanded={open} aria-label="Account menu">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink font-sign text-sm font-semibold text-white">{initials}</span>
        <span className="hidden text-left sm:block">
          <span className="block text-sm font-semibold leading-tight">{user.fullName}</span>
          <span className="block text-xs text-muted">{ROLE_LABEL[user.role]}</span>
        </span>
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-56 rounded-panel border border-rule bg-white py-1 shadow-lg" onMouseLeave={() => setOpen(false)}>
          <p className="border-b border-rule px-4 py-2 text-xs text-muted">Signed in as <strong className="text-ink">{user.username}</strong></p>
          <Link to="/change-password" className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-paper" onClick={() => setOpen(false)}><KeyRound className="h-4 w-4" />Change password</Link>
          <button onClick={() => logout()} className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-paper"><LogOut className="h-4 w-4" />Sign out</button>
        </div>
      )}
    </div>
  );
}

export default function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div className="flex min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-2">Skip to content</a>
      <aside className="no-print sticky top-0 hidden h-screen w-64 shrink-0 lg:block"><Sidebar /></aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="w-72 max-w-[85vw]"><Sidebar onNavigate={() => setMobileOpen(false)} /></div>
          <button className="flex-1 bg-ink/40" onClick={() => setMobileOpen(false)} aria-label="Close menu"><X className="ml-2 mt-2 h-6 w-6 text-white" /></button>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex items-center gap-3 border-b border-rule bg-white/95 px-4 py-2.5 backdrop-blur">
          <button className="rounded p-2 hover:bg-ink/5 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
          <PatientLookup />
          <div className="ml-auto flex items-center gap-1"><NotificationBell /><UserMenu /></div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-5 sm:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
