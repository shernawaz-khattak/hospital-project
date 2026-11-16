// Session state, inactivity handling (SRS UC-01/UC-02: 10 minutes) and live server events.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, onAuthError } from '../api/client.js';
import { setCurrency, setTimezone } from '../lib/format.js';
import { Button, Modal, useToast } from '../components/ui.jsx';
import { flushAllDrafts } from '../lib/drafts.js';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

const WARN_BEFORE_MS = 60_000;
const HEARTBEAT_EVERY_MS = 60_000;

// Map server events to the API areas that must refresh (UC-19: bed status updates in real time).
const EVENT_KEYS = {
  'beds.changed': [['api', 'wards'], ['api', 'admissions'], ['api', 'reports']],
  'appointments.changed': [['api', 'appointments'], ['api', 'reports'], ['api', 'waitlist']],
  'waitlist.changed': [['api', 'waitlist']],
  'lab.changed': [['api', 'lab'], ['api', 'reports']],
  'prescriptions.changed': [['api', 'pharmacy'], ['api', 'reports']],
  'inventory.changed': [['api', 'pharmacy']],
  'bills.changed': [['api', 'billing'], ['api', 'admissions'], ['api', 'reports']],
};

export function AuthProvider({ children }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [state, setState] = useState({ loading: true, user: null, session: null, config: null });
  const [endedReason, setEndedReason] = useState(null);
  const [warning, setWarning] = useState(false);
  const [countdown, setCountdown] = useState(60);
  const lastActivity = useRef(Date.now());
  const lastBeat = useRef(Date.now());

  const loadMe = useCallback(async () => {
    try {
      const me = await api('/auth/me', { background: true });
      setCurrency(me.config?.currency);
      setTimezone(me.config?.timezone);
      setState({ loading: false, user: me.user, session: me.session, config: me.config });
      return me.user;
    } catch {
      setState({ loading: false, user: null, session: null, config: null });
      return null;
    }
  }, []);

  useEffect(() => { loadMe(); }, [loadMe]);

  const clearSession = useCallback((reason) => {
    setWarning(false);
    setEndedReason(reason ?? null);
    setState({ loading: false, user: null, session: null, config: null });
    qc.clear();
  }, [qc]);

  useEffect(() => onAuthError((err) => {
    if (state.user) clearSession(err.code === 'SESSION_EXPIRED' ? 'Your session expired after 10 minutes of inactivity. Please sign in again.' : err.message);
  }), [state.user, clearSession]);

  const login = useCallback(async (username, password) => {
    await api('/auth/login', { method: 'POST', body: { username, password } });
    setEndedReason(null);
    lastActivity.current = Date.now();
    return loadMe();
  }, [loadMe]);

  const logout = useCallback(async (reason) => {
    await flushAllDrafts(); // UC-02: unsaved work is saved before signing out
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* already ended */ }
    clearSession(reason);
  }, [clearSession]);

  // ------------------------------------------------------------ inactivity tracking
  useEffect(() => {
    if (!state.user) return undefined;
    const idleMs = (state.session?.idleTimeoutSeconds ?? 600) * 1000;
    const mark = () => { lastActivity.current = Date.now(); };
    const events = ['mousedown', 'keydown', 'scroll', 'touchstart', 'pointermove'];
    events.forEach((e) => window.addEventListener(e, mark, { passive: true }));
    const timer = setInterval(async () => {
      const idle = Date.now() - lastActivity.current;
      if (idle >= idleMs) {
        clearInterval(timer);
        await logout('You were signed out after 10 minutes of inactivity. Your unsaved form entries were kept as drafts.');
        return;
      }
      if (idle >= idleMs - WARN_BEFORE_MS) {
        if (!warning) flushAllDrafts();
        setWarning(true);
        setCountdown(Math.max(0, Math.ceil((idleMs - idle) / 1000)));
        return;
      }
      setWarning(false);
      // Keep the server session alive only while the person is actually working.
      if (idle < HEARTBEAT_EVERY_MS && Date.now() - lastBeat.current >= HEARTBEAT_EVERY_MS - 1000) {
        lastBeat.current = Date.now();
        api('/auth/heartbeat', { method: 'POST' }).catch(() => {});
      }
    }, 1000);
    return () => {
      clearInterval(timer);
      events.forEach((e) => window.removeEventListener(e, mark));
    };
  }, [state.user, state.session, logout, warning]);

  // ------------------------------------------------------------ live events (SSE)
  useEffect(() => {
    if (!state.user) return undefined;
    const es = new EventSource('/api/events');
    es.addEventListener('notification', (e) => {
      const n = JSON.parse(e.data);
      qc.invalidateQueries({ queryKey: ['api', 'notifications'] });
      toast({ tone: n.priority === 'high' ? 'caution' : 'info', title: n.title, message: n.message, duration: 6000 });
    });
    for (const [evt, keys] of Object.entries(EVENT_KEYS)) {
      es.addEventListener(evt, () => keys.forEach((k) => qc.invalidateQueries({ queryKey: k })));
    }
    es.addEventListener('session-ended', () => { es.close(); loadMe(); });
    return () => es.close();
  }, [state.user, qc, toast, loadMe]);

  const value = useMemo(() => ({
    ...state,
    endedReason,
    login,
    logout,
    reload: loadMe,
    can: (...perms) => perms.some((p) => state.user?.permissions?.includes(p)),
  }), [state, endedReason, login, logout, loadMe]);

  return (
    <AuthCtx.Provider value={value}>
      {children}
      <Modal open={warning && Boolean(state.user)} onClose={() => { lastActivity.current = Date.now(); setWarning(false); }} title="Are you still there?" width="max-w-md"
        footer={<><Button variant="secondary" onClick={() => logout()}>Sign out now</Button><Button onClick={() => { lastActivity.current = Date.now(); lastBeat.current = Date.now(); api('/auth/heartbeat', { method: 'POST' }).catch(() => {}); setWarning(false); }}>Stay signed in</Button></>}>
        <p className="text-sm">For patient privacy you will be signed out in <strong className="font-sign text-xl tabular-nums">{countdown}</strong> seconds because there has been no activity. Unsaved form entries have been saved as drafts.</p>
      </Modal>
    </AuthCtx.Provider>
  );
}
