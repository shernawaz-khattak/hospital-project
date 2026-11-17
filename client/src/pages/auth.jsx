import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { LogIn, Mail } from 'lucide-react';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { Button, Callout, Input, Loading, Panel, useForm } from '../components/ui.jsx';
import { dateTime } from '../lib/format.js';

const DIRECTORY = [
  ['Out-patient clinics', 'appointments'], ['Wards & admissions', 'wards'], ['Laboratory', 'lab'], ['Pharmacy', 'pharmacy'], ['Accounts', 'billing'], ['Patient portal', 'patients'],
];

function AuthLayout({ children, title }) {
  const [meta, setMeta] = useState(null);
  useEffect(() => { api('/meta').then(setMeta).catch(() => {}); }, []);
  return (
    <div className="auth-layout grid min-h-screen lg:grid-cols-[1fr_1.1fr]">
      <section className="auth-visual hidden flex-col justify-between px-12 py-10 text-white lg:flex">
        <div className="flex items-center gap-3">
          <svg viewBox="0 0 32 32" className="h-10 w-10" aria-hidden><rect width="32" height="32" rx="7" fill="#fff" /><path d="M13 7h6v6h6v6h-6v6h-6v-6H7v-6h6z" fill="#12282F" /><rect x="0" y="26" width="32" height="6" fill="#0B6B5A" /></svg>
          <div>
            <p className="font-sign text-2xl font-semibold leading-tight">{meta?.hospitalName ?? 'Hospital'}</p>
            <p className="text-sm text-white/60">Hospital Management System</p>
          </div>
        </div>
        <div>
          <p className="max-w-sm font-sign text-3xl font-medium leading-tight">One record for every patient, from the front desk to the pharmacy counter.</p>
          <ul className="mt-8 max-w-sm space-y-1.5">
            {DIRECTORY.map(([name, way]) => (
              <li key={name} className="flex items-center justify-between rounded bg-white/[0.06] py-2 pl-4 pr-3 text-sm" style={{ boxShadow: `inset 5px 0 0 var(--way-${way})` }}>
                <span>{name}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-white/50">Authorised staff and registered patients only. Activity is recorded in the audit log.</p>
      </section>
      <section className="auth-form-panel flex items-center justify-center px-5 py-10">
        <div className="auth-card w-full max-w-sm">
          <h1 className="font-sign text-3xl font-semibold">{title}</h1>
          <div className="mt-6">{children}</div>
          {meta?.devOutbox && (
            <p className="mt-8 border-t border-rule pt-4 text-xs text-muted">
              Development mode: emails are not delivered. A system administrator can read them in the <Link to="/dev/outbox" className="link">development mailbox</Link>.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

export function LoginPage() {
  const { user, login, endedReason } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const f = useForm({ username: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  if (user) return <Navigate to={user.mustChangePassword ? '/change-password' : loc.state?.from ?? user.home} replace />;
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = await login(f.values.username.trim(), f.values.password);
      nav(u.mustChangePassword ? '/change-password' : loc.state?.from ?? u.home, { replace: true });
    } catch (err) {
      setError(err);
      f.fromError(err);
      f.set('password', '');
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout title="Sign in">
      {endedReason && <Callout tone="caution" className="mb-4">{endedReason}</Callout>}
      {error && <Callout tone={error.code === 'ACCOUNT_LOCKED' ? 'alert' : 'caution'} className="mb-4">{error.message}</Callout>}
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Input label="Username" autoComplete="username" autoFocus required hint="Patients sign in with their patient ID." {...f.bind('username')} />
        <Input label="Password" type="password" autoComplete="current-password" required {...f.bind('password')} />
        <Button type="submit" className="w-full" size="lg" icon={LogIn} loading={busy} disabled={!f.values.username || !f.values.password}>Sign in</Button>
      </form>
      <p className="mt-4 text-sm"><Link to="/forgot-password" className="link">Forgot your password?</Link></p>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const f = useForm({ email: '' });
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setDone(await api('/auth/forgot-password', { method: 'POST', body: { email: f.values.email.trim() } }));
    } catch (err) {
      f.fromError(err);
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout title="Reset your password">
      {done ? (
        <Callout tone="ok" title="Check your email">
          {done.emailMode === 'dev-outbox'
            ? <>A reset link was created. Email delivery is not configured in this development setup, so the message was saved to the <Link className="link" to="/dev/outbox">development mailbox</Link> instead of being sent.</>
            : 'We sent a password reset link to your registered email address. The link expires in 24 hours.'}
        </Callout>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <p className="text-sm text-muted">Enter the email address registered to your account. We will send you a link to choose a new password.</p>
          {error && !error.fields?.email && <Callout tone="alert">{error.message}</Callout>}
          <Input label="Registered email" type="email" autoComplete="email" required {...f.bind('email')} />
          <Button type="submit" className="w-full" icon={Mail} loading={busy}>Send reset link</Button>
        </form>
      )}
      <p className="mt-4 text-sm"><Link to="/login" className="link">Back to sign in</Link></p>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const { token } = useParams();
  const nav = useNavigate();
  const [valid, setValid] = useState(null);
  const f = useForm({ password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`/auth/reset-password/${token}`).then(() => setValid(true)).catch((err) => setValid(err));
  }, [token]);
  const submit = async (e) => {
    e.preventDefault();
    if (f.values.password !== f.values.confirm) return f.setErrors({ confirm: 'The passwords do not match.' });
    setBusy(true);
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token, password: f.values.password } });
      nav('/login', { replace: true, state: { reset: true } });
    } catch (err) {
      f.fromError(err);
      if (!err.fields?.password) setValid(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout title="Choose a new password">
      {valid === null && <Loading />}
      {valid instanceof Error && <Callout tone="alert" title="This link cannot be used">{valid.message} <Link to="/forgot-password" className="link">Request a new link</Link>.</Callout>}
      {valid === true && (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Input label="New password" type="password" autoComplete="new-password" hint="At least 8 characters with upper- and lowercase letters and a number." {...f.bind('password')} />
          <Input label="Confirm new password" type="password" autoComplete="new-password" {...f.bind('confirm')} />
          <Button type="submit" className="w-full" loading={busy}>Save new password</Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ChangePasswordPage() {
  const { user, reload } = useAuth();
  const nav = useNavigate();
  const f = useForm({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  if (!user) return <Navigate to="/login" replace />;
  const submit = async (e) => {
    e.preventDefault();
    if (f.values.newPassword !== f.values.confirm) return f.setErrors({ confirm: 'The passwords do not match.' });
    setBusy(true);
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: f.values.currentPassword, newPassword: f.values.newPassword } });
      setDone(true);
      const u = await reload();
      setTimeout(() => nav(u.home, { replace: true }), 900);
    } catch (err) {
      f.fromError(err);
    } finally {
      setBusy(false);
    }
  };
  const form = (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {user.mustChangePassword && <Callout tone="caution">You signed in with a temporary password. Choose your own password to continue.</Callout>}
      {done && <Callout tone="ok">Password changed.</Callout>}
      <Input label="Current password" type="password" autoComplete="current-password" {...f.bind('currentPassword')} />
      <Input label="New password" type="password" autoComplete="new-password" hint="At least 8 characters with upper- and lowercase letters and a number." {...f.bind('newPassword')} />
      <Input label="Confirm new password" type="password" autoComplete="new-password" {...f.bind('confirm')} />
      <Button type="submit" loading={busy}>Change password</Button>
    </form>
  );
  return user.mustChangePassword ? <AuthLayout title="Set your password">{form}</AuthLayout> : <div className="max-w-md"><Panel title="Change password">{form}</Panel></div>;
}

export function DevOutboxPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api('/dev/outbox').then(setData).catch(setErr); }, []);
  return (
    <div className="mx-auto max-w-3xl px-5 py-8">
      <h1 className="font-sign text-3xl font-semibold">Development mailbox</h1>
      {err && <Callout tone="alert" className="mt-4">{err.status === 401 || err.status === 403 ? 'Sign in as the system administrator (sysadmin) to read the development mailbox. It contains password-reset links, so other users cannot see it.' : 'The development mailbox is only available in development mode without SMTP.'}</Callout>}
      {data && <Callout tone="caution" className="mt-4">{data.notice}</Callout>}
      <ul className="mt-5 space-y-3">
        {data?.data.map((m) => (
          <li key={m.id} className="panel p-4">
            <p className="text-xs text-muted">To {m.to}, {dateTime(m.createdAt)}</p>
            <p className="font-semibold">{m.subject}</p>
            <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm">{m.body.split(/(https?:\/\/\S+)/g).map((part, i) => (/^https?:\/\//.test(part) ? <a key={i} className="link" href={part.replace(/^https?:\/\/[^/]+/, '')}>{part}</a> : part))}</pre>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-sm"><Link to="/login" className="link">Back to sign in</Link></p>
    </div>
  );
}
