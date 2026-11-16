import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Info, Loader2, X, XCircle } from 'lucide-react';
import { statusOf } from '../lib/format.js';

const cx = (...c) => c.filter(Boolean).join(' ');
export { cx };

// ----------------------------------------------------------------- buttons
const VARIANTS = {
  primary: 'bg-scrub text-white hover:bg-scrub-dark border border-scrub-dark/40',
  secondary: 'bg-white text-ink border border-rule hover:border-ink/30 hover:bg-paper',
  danger: 'bg-alert text-white hover:bg-[#8f1c13] border border-[#8f1c13]',
  ghost: 'bg-transparent text-ink hover:bg-ink/5 border border-transparent',
  quiet: 'bg-transparent text-scrub hover:bg-scrub-light border border-transparent',
};
export function Button({ variant = 'primary', size = 'md', loading, icon: Icon, children, className, disabled, ...rest }) {
  const sizes = { sm: 'px-2.5 py-1.5 text-sm gap-1.5', md: 'px-3.5 py-2 text-sm gap-2', lg: 'px-5 py-2.5 text-base gap-2' };
  return (
    <button type="button" className={cx('inline-flex items-center justify-center rounded font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-55', VARIANTS[variant], sizes[size], className)} disabled={disabled || loading} {...rest}>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden /> : null}
      {children}
    </button>
  );
}

// ----------------------------------------------------------------- form fields
export function Field({ label, error, hint, required, children, className }) {
  const id = useId();
  const child = typeof children === 'function' ? children({ id, invalid: Boolean(error), describedBy: error ? `${id}-err` : hint ? `${id}-hint` : undefined }) : children;
  return (
    <div className={className}>
      {label && (
        <div className="mb-1 flex text-sm font-semibold text-ink">
          <label htmlFor={id}>{label}</label>
          {required && <span className="ml-0.5 text-alert" aria-hidden>*</span>}
        </div>
      )}
      {child}
      {hint && !error && <p id={`${id}-hint`} className="mt-1 text-xs text-muted">{hint}</p>}
      {error && <p id={`${id}-err`} className="mt-1 text-xs font-semibold text-alert" role="alert">{error}</p>}
    </div>
  );
}

export function Input({ label, error, hint, required, className, ...rest }) {
  return (
    <Field label={label} error={error} hint={hint} required={required} className={className}>
      {({ id, invalid, describedBy }) => <input id={id} aria-invalid={invalid} aria-describedby={describedBy} required={required} className="field-input" {...rest} />}
    </Field>
  );
}

export function Select({ label, error, hint, required, options = [], placeholder, className, ...rest }) {
  return (
    <Field label={label} error={error} hint={hint} required={required} className={className}>
      {({ id, invalid, describedBy }) => (
        <select id={id} aria-invalid={invalid} aria-describedby={describedBy} required={required} className="field-input pr-8" {...rest}>
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {options.map((o) => (typeof o === 'object' ? <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option> : <option key={o} value={o}>{o}</option>))}
        </select>
      )}
    </Field>
  );
}

export function Textarea({ label, error, hint, required, className, rows = 3, ...rest }) {
  return (
    <Field label={label} error={error} hint={hint} required={required} className={className}>
      {({ id, invalid, describedBy }) => <textarea id={id} rows={rows} aria-invalid={invalid} aria-describedby={describedBy} required={required} className="field-input" {...rest} />}
    </Field>
  );
}

export function Checkbox({ label, hint, className, ...rest }) {
  const id = useId();
  return (
    <div className={cx('flex items-start gap-2.5', className)}>
      <input id={id} type="checkbox" className="mt-0.5 h-4 w-4 rounded border-rule accent-scrub" {...rest} />
      <label htmlFor={id} className="text-sm">
        <span className="font-semibold">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </label>
    </div>
  );
}

/** Minimal form state helper: values, setters and server-side field errors. */
export function useForm(initial) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const set = useCallback((name, value) => {
    setValues((v) => ({ ...v, [name]: value }));
    setErrors((e) => (e[name] ? { ...e, [name]: undefined } : e));
  }, []);
  const bind = (name, { type } = {}) => ({
    name,
    value: type === 'checkbox' ? undefined : values[name] ?? '',
    checked: type === 'checkbox' ? Boolean(values[name]) : undefined,
    onChange: (e) => set(name, type === 'checkbox' ? e.target.checked : e.target.value),
    error: errors[name],
  });
  const fromError = (err) => setErrors(err?.fields ?? {});
  return { values, setValues, set, bind, errors, setErrors, fromError, reset: () => { setValues(initial); setErrors({}); } };
}

// ----------------------------------------------------------------- status, feedback
const TONES = {
  ok: 'bg-ok-light text-ok border-ok/20', info: 'bg-info-light text-info border-info/20', caution: 'bg-caution-light text-caution border-caution/25',
  alert: 'bg-alert-light text-alert border-alert/20', neutral: 'bg-ink/5 text-ink-soft border-ink/10',
};
export function Status({ value, label, tone, className }) {
  const s = statusOf(value);
  return <span className={cx('inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold', TONES[tone ?? s.tone], className)}>{label ?? s.label}</span>;
}

export function Callout({ tone = 'info', title, children, className, action }) {
  const Icon = { ok: CheckCircle2, info: Info, caution: AlertTriangle, alert: XCircle }[tone] ?? Info;
  return (
    <div className={cx('flex gap-3 rounded-panel border p-3.5', TONES[tone], className)} role={tone === 'alert' ? 'alert' : 'status'}>
      <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 text-sm text-ink">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? 'mt-0.5' : ''}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function Spinner({ className }) {
  return <Loader2 className={cx('h-5 w-5 animate-spin text-scrub', className)} aria-label="Loading" />;
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="flex items-center gap-3 px-4 py-10 text-sm text-muted" role="status">
      <Spinner /> {label}
    </div>
  );
}

export function EmptyState({ icon: Icon = Info, title, children, action }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <Icon className="h-9 w-9 text-muted/60" aria-hidden />
      <p className="mt-3 font-sign text-lg font-semibold">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  if (!error) return null;
  return (
    <Callout tone="alert" title={error.status === 403 ? 'Access denied' : 'This could not be loaded'} action={onRetry && <Button size="sm" variant="secondary" onClick={onRetry}>Try again</Button>}>
      {error.message}
    </Callout>
  );
}

/** Renders loading / error / content for a react-query result. */
export function QueryState({ query, children, empty, loadingLabel }) {
  if (query.isLoading) return <Loading label={loadingLabel} />;
  if (query.error) return <div className="p-4"><ErrorState error={query.error} onRetry={() => query.refetch()} /></div>;
  if (empty && empty.when(query.data)) return empty.render;
  return children(query.data);
}

// ----------------------------------------------------------------- layout pieces
export function PageHeader({ title, subtitle, way = 'home', actions, back }) {
  return (
    <header className="way-band mb-5 flex flex-wrap items-end justify-between gap-3 rounded-panel border border-rule bg-white py-4 pl-6 pr-4" style={{ '--way': `var(--way-${way})` }}>
      <div className="min-w-0">
        {back}
        <h1 className="text-2xl font-semibold leading-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Panel({ title, actions, children, className, bodyClass, subtitle }) {
  return (
    <section className={cx('panel', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule px-4 py-3">
          <div>
            {title && <h2 className="text-lg font-semibold">{title}</h2>}
            {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={bodyClass ?? 'p-4'}>{children}</div>
    </section>
  );
}

/** A single banded strip of key numbers separated by rules (not a grid of cards). */
export function StatStrip({ items }) {
  return (
    <div className="panel grid grid-cols-2 divide-rule overflow-hidden sm:grid-cols-3 lg:flex lg:divide-x">
      {items.map((it) => (
        <div key={it.label} className={cx('min-w-0 flex-1 border-b border-rule px-4 py-3 lg:border-b-0', it.tone === 'alert' && 'bg-alert-light/60', it.tone === 'caution' && 'bg-caution-light/60')}>
          <p className="font-sign text-3xl font-semibold leading-none tabular-nums">{it.value}</p>
          <p className="mt-1.5 text-xs font-semibold text-muted">{it.label}</p>
          {it.hint && <p className="text-xs text-muted">{it.hint}</p>}
        </div>
      ))}
    </div>
  );
}

export function KeyValue({ items, cols = 2 }) {
  return (
    <dl className={cx('grid gap-x-6 gap-y-3', cols === 3 ? 'sm:grid-cols-3' : cols === 1 ? '' : 'sm:grid-cols-2')}>
      {items.filter(Boolean).map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs font-semibold text-muted">{k}</dt>
          <dd className="mt-0.5 break-words text-sm">{v === null || v === undefined || v === '' ? <span className="text-muted">—</span> : v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** OPD token number, shown in signage numerals. */
export function Token({ n, muted }) {
  return <span className={cx('inline-flex h-9 min-w-9 items-center justify-center rounded border-2 px-1.5 font-sign text-xl font-bold tabular-nums', muted ? 'border-rule text-muted' : 'border-ink text-ink')} aria-label={`Token ${n}`}>{n}</span>;
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-rule" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}
          className={cx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold transition-colors', value === t.value ? 'border-scrub text-ink' : 'border-transparent text-muted hover:text-ink')}>
          {t.label}{t.count !== undefined && <span className="ml-1.5 rounded-full bg-ink/5 px-1.5 text-xs">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------- table + pagination
export function Table({ columns, rows, rowKey = 'id', onRowClick, empty, className }) {
  if (!rows?.length) return empty ?? <EmptyState title="Nothing to show" />;
  return (
    <div className={cx('overflow-x-auto', className)}>
      <table className="table-base">
        <thead>
          <tr>{columns.map((c) => <th key={c.key ?? c.header} className={c.className} style={{ width: c.width }}>{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={typeof rowKey === 'function' ? rowKey(r) : r[rowKey]} onClick={onRowClick ? () => onRowClick(r) : undefined} className={onRowClick ? 'cursor-pointer' : undefined}>
              {columns.map((c) => <td key={c.key ?? c.header} className={c.className}>{c.render ? c.render(r) : r[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onChange }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return <p className="px-4 py-2.5 text-xs text-muted">{total} record{total === 1 ? '' : 's'}</p>;
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
      <span className="text-xs text-muted">{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}</span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" icon={ChevronLeft} disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page" />
        <span className="px-2 text-xs">Page {page} of {pages}</span>
        <Button size="sm" variant="ghost" icon={ChevronRight} disabled={page >= pages} onClick={() => onChange(page + 1)} aria-label="Next page" />
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- modal & confirm
export function Modal({ open, onClose, title, children, footer, width = 'max-w-lg' }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.activeElement;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', onKey);
    setTimeout(() => ref.current?.querySelector('input,select,textarea,button:not([data-close])')?.focus(), 10);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={cx('flex max-h-[92vh] w-full flex-col rounded-t-panel bg-white shadow-xl sm:rounded-panel', width)}>
        <div className="flex items-center justify-between border-b border-rule px-5 py-3.5">
          <h2 className="text-xl font-semibold">{title}</h2>
          <button data-close onClick={onClose} className="rounded p-1 text-muted hover:bg-ink/5 hover:text-ink" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-rule px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

const ConfirmCtx = createContext(null);
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const confirm = useCallback((opts) => new Promise((resolve) => setState({ ...opts, resolve })), []);
  const close = (v) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal open={Boolean(state)} onClose={() => close(false)} title={state?.title ?? 'Are you sure?'} width="max-w-md"
        footer={<><Button variant="secondary" onClick={() => close(false)}>{state?.cancelLabel ?? 'Cancel'}</Button><Button variant={state?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{state?.confirmLabel ?? 'Confirm'}</Button></>}>
        <div className="text-sm">{state?.message}</div>
      </Modal>
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmCtx);

// ----------------------------------------------------------------- toasts
const ToastCtx = createContext(null);
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((all) => [...all.slice(-3), { id, tone: 'ok', ...t }]);
    setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), t.duration ?? (t.tone === 'alert' ? 7000 : 4500));
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(92vw,380px)] flex-col gap-2" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className="pointer-events-auto">
              <Callout tone={t.tone} title={t.title} action={<button onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))} aria-label="Dismiss" className="text-muted hover:text-ink"><X className="h-4 w-4" /></button>}>
                {t.message}
              </Callout>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);
