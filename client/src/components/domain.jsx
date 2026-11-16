// Domain widgets shared across modules: patient picker, doctor picker, slot picker, print header.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import { api, qs } from '../api/client.js';
import { useApi } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { Field, Select, Spinner, Status, cx } from './ui.jsx';
import { date, WEEKDAYS } from '../lib/format.js';

/** Patient search: type a name, phone or patient ID; verifies exact IDs (UC-14). */
export function PatientPicker({ value, onChange, label = 'Patient', error, required, autoFocus }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return undefined; }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await api(`/patients${qs({ q: q.trim(), pageSize: 8 })}`, { signal: ctrl.signal });
        setResults(r.data);
        setOpen(true);
      } catch { /* aborted */ } finally { setBusy(false); }
    }, 250);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q]);

  if (value) {
    return (
      <Field label={label} error={error} required={required}>
        {() => (
          <div className="flex items-center justify-between gap-3 rounded border border-scrub/40 bg-scrub-light/40 px-3 py-2">
            <div className="min-w-0">
              <p className="font-semibold">{value.fullName} <span className="font-normal text-muted">{value.patientCode}</span></p>
              <p className="text-xs text-muted">{[value.age != null && `${value.age} y`, value.gender, value.phone].filter(Boolean).join(', ')}</p>
            </div>
            {value.status && <Status value={value.status} />}
            <button type="button" onClick={() => onChange(null)} className="rounded p-1 text-muted hover:bg-white hover:text-ink" aria-label="Change patient"><X className="h-4 w-4" /></button>
          </div>
        )}
      </Field>
    );
  }
  return (
    <Field label={label} error={error} required={required} hint="Search by name, phone, CNIC or patient ID">
      {({ id, invalid }) => (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted" aria-hidden />
          <input id={id} aria-invalid={invalid} autoFocus={autoFocus} className="field-input pl-8" value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => results.length && setOpen(true)} placeholder="Start typing…" autoComplete="off" role="combobox" aria-expanded={open} />
          {busy && <Spinner className="absolute right-2.5 top-2.5 h-4 w-4" />}
          {open && q.trim().length >= 2 && (
            <ul className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-panel border border-rule bg-white shadow-lg" role="listbox">
              {results.length === 0 && !busy && <li className="px-3 py-3 text-sm text-muted">No patient matches “{q}”. Check the spelling or register the patient.</li>}
              {results.map((p) => (
                <li key={p.id}>
                  <button type="button" role="option" aria-selected="false" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-paper focus:bg-paper" onClick={() => { onChange(p); setQ(''); setOpen(false); }}>
                    <span><span className="font-semibold">{p.fullName}</span> <span className="text-muted">{p.patientCode}</span><span className="block text-xs text-muted">{p.age} y, {p.gender}, {p.phone}</span></span>
                    <Status value={p.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Field>
  );
}

export function DoctorSelect({ value, onChange, label = 'Doctor', error, required, departmentId }) {
  const q = useApi(`/doctors${qs({ departmentId })}`);
  const docs = q.data?.data ?? [];
  return (
    <Select label={label} error={error} required={required} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null, docs.find((d) => d.id === Number(e.target.value)))}
      placeholder={q.isLoading ? 'Loading doctors…' : 'Choose a doctor'} options={docs.map((d) => ({ value: d.id, label: `${d.fullName} — ${d.specialization}` }))} />
  );
}

export function useDoctors() {
  return useApi('/doctors');
}

/** Slot grid for a doctor/date; booked and past slots are disabled. */
export function SlotPicker({ doctorId, date: day, value, onChange, error }) {
  const q = useApi(doctorId && day ? `/appointments/slots${qs({ doctorId, date: day })}` : null);
  if (!doctorId || !day) return <p className="text-sm text-muted">Choose a doctor and a date to see available times.</p>;
  if (q.isLoading) return <Spinner />;
  if (q.error) return <p className="text-sm text-alert">{q.error.message}</p>;
  const { slots, worksThisDay, doctor } = q.data;
  if (!worksThisDay) return <p className="rounded border border-caution/30 bg-caution-light px-3 py-2 text-sm">{doctor.fullName} does not see patients on {WEEKDAYS[new Date(`${day}T12:00:00`).getDay()]}s. Choose another date.</p>;
  const free = slots.filter((s) => s.available).length;
  return (
    <div>
      <p className="mb-2 text-sm"><strong>{free}</strong> of {slots.length} slots free on {date(day)}</p>
      <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6 lg:grid-cols-8" role="radiogroup" aria-label="Time slot">
        {slots.map((s) => (
          <button key={s.startTime} type="button" role="radio" aria-checked={value === s.startTime} disabled={!s.available} onClick={() => onChange(s.startTime)}
            className={cx('rounded border px-1 py-1.5 text-sm font-semibold tabular-nums transition-colors',
              value === s.startTime ? 'border-scrub bg-scrub text-white' : s.available ? 'border-rule bg-white hover:border-scrub hover:bg-scrub-light' : 'cursor-not-allowed border-transparent bg-ink/5 text-muted line-through decoration-ink/30')}
            title={s.booked ? 'Booked' : s.past ? 'Time has passed' : 'Available'}>
            {s.startTime}
          </button>
        ))}
      </div>
      {error && <p className="mt-1 text-xs font-semibold text-alert">{error}</p>}
      {free === 0 && <p className="mt-2 text-sm text-caution">All slots are taken on this date.</p>}
    </div>
  );
}

/** Letterhead for printed documents (bills, receipts, discharge summaries, records). */
export function PrintHeader({ title, subtitle }) {
  const { config } = useAuth();
  return (
    <div className="mb-5 flex items-start justify-between border-b-2 border-ink pb-3">
      <div>
        <p className="font-sign text-2xl font-semibold">{config?.hospitalName}</p>
        <p className="text-xs text-muted">Hospital Management System</p>
      </div>
      <div className="text-right">
        <p className="font-sign text-xl font-semibold">{title}</p>
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
      </div>
    </div>
  );
}

export function BackLink({ to, children }) {
  return <Link to={to} className="mb-1 inline-block text-sm text-muted hover:text-ink">← {children}</Link>;
}
