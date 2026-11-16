// Appointments (SRS FR-11..13; UC-15 Book, UC-16 Cancel/Reschedule, UC-17 Waitlist).
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CalendarPlus, ListOrdered } from 'lucide-react';
import { api, post, qs } from '../api/client.js';
import { useAction, useApi } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { BackLink, DoctorSelect, PatientPicker, SlotPicker } from '../components/domain.jsx';
import { Button, Callout, EmptyState, Input, KeyValue, Modal, PageHeader, Panel, QueryState, Select, Status, Table, Textarea, Token, useForm } from '../components/ui.jsx';
import { addDays, date, dateTime, relative, time, today, weekday } from '../lib/format.js';

// ----------------------------------------------------------------- shared booking form
export function BookingForm({ fixedPatient, onBooked, channel = 'reception' }) {
  const [params] = useSearchParams();
  const [patient, setPatient] = useState(fixedPatient ?? null);
  const [doctorId, setDoctorId] = useState(params.get('doctorId') ? Number(params.get('doctorId')) : null);
  const [day, setDay] = useState(today());
  const [slot, setSlot] = useState(null);
  const [reason, setReason] = useState('');
  const [conflict, setConflict] = useState(null);
  const [waitlisted, setWaitlisted] = useState(null);
  const { can } = useAuth();

  useEffect(() => {
    const pid = params.get('patientId');
    if (pid && !fixedPatient) api(`/patients/${pid}`).then(setPatient).catch(() => {});
  }, [params, fixedPatient]);
  useEffect(() => { setSlot(null); setConflict(null); }, [doctorId, day]);

  const book = useAction((body) => post('/appointments', body), {
    quietErrors: true,
    onError: (err) => { setConflict(err); return true; },
    onSuccess: (a) => onBooked(a),
    invalidate: ['appointments', 'reports'],
  });
  const waitlist = useAction(() => post('/waitlist', { patientId: patient.id, doctorId, preferredDate: day, notes: reason }), {
    onSuccess: (r) => setWaitlisted(r), invalidate: ['waitlist'],
  });
  const slotsQ = useApi(doctorId && day ? `/appointments/slots${qs({ doctorId, date: day })}` : null);
  const full = slotsQ.data?.worksThisDay && slotsQ.data.slots.length > 0 && slotsQ.data.slots.every((s) => !s.available);

  if (waitlisted) {
    return <Callout tone="ok" title={`Added to the waitlist in position ${waitlisted.position}`}>The patient and reception will be notified when a slot opens on {date(day)}, first come first served.</Callout>;
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); book.mutate({ patientId: patient?.id, doctorId, date: day, startTime: slot, reason }); }} className="space-y-5" noValidate>
      {!fixedPatient && <PatientPicker value={patient} onChange={setPatient} required error={conflict?.fields?.patientId} autoFocus />}
      <div className="grid gap-4 sm:grid-cols-2">
        <DoctorSelect value={doctorId} onChange={setDoctorId} required />
        <div>
          <Input label="Date" type="date" min={today()} max={addDays(today(), 90)} value={day} onChange={(e) => setDay(e.target.value)} required />
          <div className="mt-1.5 flex gap-1">{[0, 1, 2, 3, 4, 5, 6].map((n) => { const d = addDays(today(), n); return <button key={d} type="button" onClick={() => setDay(d)} className={`rounded border px-2 py-0.5 text-xs ${d === day ? 'border-scrub bg-scrub-light font-semibold' : 'border-rule hover:bg-paper'}`}>{n === 0 ? 'Today' : weekday(d)}</button>; })}</div>
        </div>
      </div>
      <div>
        <p className="mb-2 text-sm font-semibold">Time</p>
        <SlotPicker doctorId={doctorId} date={day} value={slot} onChange={setSlot} />
      </div>
      <Textarea label="Reason for visit" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. follow-up, fever, report review" />

      {conflict && (
        <Callout tone="caution" title={conflict.message}>
          {conflict.details?.suggestions?.length > 0 && (
            <>
              <p>Next available:</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {conflict.details.suggestions.map((s) => (
                  <Button key={`${s.date}${s.startTime}`} size="sm" variant="secondary" onClick={() => { setDay(s.date); setTimeout(() => setSlot(s.startTime), 0); setConflict(null); }}>
                    {s.date === day ? '' : `${weekday(s.date)} ${date(s.date)}, `}{s.startTime}
                  </Button>
                ))}
              </div>
            </>
          )}
        </Callout>
      )}
      {full && patient && can('waitlist.manage') && (
        <Callout tone="info" title="All slots are taken on this date" action={<Button size="sm" icon={ListOrdered} loading={waitlist.isPending} onClick={() => waitlist.mutate()}>Add to waitlist</Button>}>
          Add the patient to the waitlist and they will be offered the first slot that frees up.
        </Callout>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="lg" icon={CalendarPlus} disabled={!patient || !doctorId || !slot} loading={book.isPending}>Confirm booking</Button>
      </div>
    </form>
  );
}

export function BookAppointmentPage() {
  const nav = useNavigate();
  const [booked, setBooked] = useState(null);
  return (
    <div className="max-w-4xl">
      <PageHeader way="appointments" title="Book appointment" back={<BackLink to="/appointments">Appointments</BackLink>} />
      {booked ? <BookedConfirmation a={booked} onAnother={() => setBooked(null)} onDone={() => nav(`/appointments?date=${booked.date}`)} /> : <Panel><BookingForm onBooked={setBooked} /></Panel>}
    </div>
  );
}

export function BookedConfirmation({ a, onAnother, onDone, anotherLabel = 'Book another' }) {
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-5">
        <div className="text-center">
          <p className="text-xs font-semibold text-muted">Token</p>
          <p className="font-sign text-6xl font-bold leading-none tabular-nums">{a.tokenNumber}</p>
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-sign text-2xl font-semibold">Appointment confirmed</p>
          <p className="text-sm">{a.patient.fullName} with {a.doctor.fullName} on {weekday(a.date)} {date(a.date)} at {time(a.startTime)}.</p>
          <p className="text-xs text-muted">Appointment ID {a.appointmentCode}. A confirmation has been sent to the patient.</p>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2"><Button variant="secondary" onClick={onAnother}>{anotherLabel}</Button><Button onClick={onDone}>Done</Button></div>
    </Panel>
  );
}

// ----------------------------------------------------------------- list
export function AppointmentsPage() {
  const [params, setParams] = useSearchParams();
  const day = params.get('date') === 'today' || !params.get('date') ? today() : params.get('date');
  const [doctorId, setDoctorId] = useState(null);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const q = useApi(`/appointments${qs({ date: day, doctorId, status, q: search, pageSize: 200 })}`);
  const [active, setActive] = useState(null);
  return (
    <div>
      <PageHeader way="appointments" title="Appointments" subtitle={`${weekday(day)} ${date(day)}`} actions={<Link to="/appointments/book"><Button icon={CalendarPlus}>Book appointment</Button></Link>} />
      <Panel bodyClass="">
        <div className="flex flex-wrap items-end gap-3 border-b border-rule p-3">
          <div className="flex items-center gap-1">
            <Button size="sm" variant="secondary" onClick={() => setParams({ date: addDays(day, -1) })} aria-label="Previous day">‹</Button>
            <input type="date" className="field-input w-44" value={day} onChange={(e) => setParams({ date: e.target.value })} aria-label="Date" />
            <Button size="sm" variant="secondary" onClick={() => setParams({ date: addDays(day, 1) })} aria-label="Next day">›</Button>
            {day !== today() && <Button size="sm" variant="ghost" onClick={() => setParams({})}>Today</Button>}
          </div>
          <div className="w-72"><DoctorSelect label="" value={doctorId} onChange={setDoctorId} /></div>
          <select className="field-input w-52" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">All statuses</option><option value="scheduled,cancellation_requested">Scheduled</option><option value="completed">Completed</option><option value="cancelled,rescheduled">Cancelled or moved</option><option value="no_show">No-show</option>
          </select>
          <input className="field-input w-56" placeholder="Patient name or ID" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
        </div>
        <QueryState query={q}>
          {(r) => (
            <Table rows={r.data} onRowClick={setActive} empty={<EmptyState title="No appointments on this day" action={<Link to="/appointments/book"><Button>Book one</Button></Link>} />} columns={[
              { header: 'Token', render: (a) => <Token n={a.tokenNumber} muted={a.status !== 'scheduled'} />, width: 70 },
              { header: 'Time', render: (a) => <span className="font-semibold tabular-nums">{time(a.startTime)}</span> },
              { header: 'Patient', render: (a) => <><p className="font-semibold">{a.patient.fullName}</p><p className="text-xs text-muted">{a.patient.patientCode}, {a.patient.phone}</p></> },
              { header: 'Doctor', render: (a) => <>{a.doctor.fullName}<span className="block text-xs text-muted">{a.doctor.specialization}</span></> },
              { header: 'Reason', key: 'reason' },
              { header: 'Booked via', render: (a) => <span className="text-xs">{a.bookingChannel}</span> },
              { header: 'Status', render: (a) => <Status value={a.status} /> },
            ]} />
          )}
        </QueryState>
      </Panel>
      {active && <AppointmentModal a={active} onClose={() => setActive(null)} />}
    </div>
  );
}

/** Details with cancel / reschedule / no-show actions (UC-16). */
export function AppointmentModal({ a, onClose }) {
  const [mode, setMode] = useState(null);
  const f = useForm({ reason: '' });
  const [newDay, setNewDay] = useState(a.date);
  const [slot, setSlot] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const { can } = useAuth();
  const startsAt = new Date(a.startsAt);
  const within1h = startsAt - Date.now() <= 3600_000 && startsAt > Date.now();
  const opts = { invalidate: ['appointments', 'reports', 'waitlist', 'portal'], onError: (e) => { f.fromError(e); return Boolean(e.fields); } };
  const cancel = useAction(() => post(`/appointments/${a.id}/cancel`, { reason: f.values.reason }), { ...opts, onSuccess: (r) => setOutcome(r.message) });
  const reschedule = useAction(() => post(`/appointments/${a.id}/reschedule`, { date: newDay, startTime: slot, reason: f.values.reason }), { ...opts, onSuccess: (r) => setOutcome(`Moved to ${date(r.date)} at ${r.startTime}. New token ${r.tokenNumber}.`) });
  const noShow = useAction(() => post(`/appointments/${a.id}/no-show`), { ...opts, success: 'Marked as no-show', onSuccess: onClose });
  const open = a.status === 'scheduled';
  return (
    <Modal open onClose={onClose} title={`Appointment ${a.appointmentCode}`} width="max-w-2xl"
      footer={outcome ? <Button onClick={onClose}>Close</Button> : !mode ? (
        <>
          {open && startsAt < new Date() && can('appointments.manage') && <Button variant="secondary" onClick={() => noShow.mutate()} loading={noShow.isPending}>Mark no-show</Button>}
          {open && startsAt > new Date() && <><Button variant="secondary" onClick={() => setMode('reschedule')}>Reschedule</Button><Button variant="danger" onClick={() => setMode('cancel')}>Cancel appointment</Button></>}
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </>
      ) : mode === 'cancel' ? (
        <><Button variant="secondary" onClick={() => setMode(null)}>Back</Button><Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}>{within1h ? 'Request cancellation' : 'Cancel appointment'}</Button></>
      ) : (
        <><Button variant="secondary" onClick={() => setMode(null)}>Back</Button><Button disabled={!slot} loading={reschedule.isPending} onClick={() => reschedule.mutate()}>Move appointment</Button></>
      )}>
      {outcome ? <Callout tone="ok">{outcome}</Callout> : (
        <>
          <div className="flex items-start gap-4">
            <Token n={a.tokenNumber} />
            <KeyValue items={[['Patient', `${a.patient.fullName} (${a.patient.patientCode})`], ['Doctor', `${a.doctor.fullName}, ${a.doctor.specialization}`], ['When', `${weekday(a.date)} ${date(a.date)}, ${time(a.startTime)}–${time(a.endTime)}`], ['Status', <Status key="s" value={a.status} />], ['Reason', a.reason], ['Booked', dateTime(a.createdAt)], a.cancellationReason && ['Cancellation reason', a.cancellationReason]]} />
          </div>
          {mode && (
            <div className="mt-5 space-y-4 border-t border-rule pt-4">
              {mode === 'cancel' && within1h && <Callout tone="caution" title="This appointment starts within 1 hour">The cancellation will be sent to an administrator for approval.</Callout>}
              {mode === 'reschedule' && (
                <>
                  <Input label="New date" type="date" min={today()} value={newDay} onChange={(e) => { setNewDay(e.target.value); setSlot(null); }} />
                  <SlotPicker doctorId={a.doctor.id} date={newDay} value={slot} onChange={setSlot} error={reschedule.error?.fields?.startTime} />
                  {reschedule.error && !reschedule.error.fields?.reason && <Callout tone="caution">{reschedule.error.message}</Callout>}
                </>
              )}
              <Textarea label="Reason" required rows={2} {...f.bind('reason')} />
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

// ----------------------------------------------------------------- waitlist (UC-17)
export function WaitlistPage() {
  const [status, setStatus] = useState('open');
  const q = useApi(`/waitlist?status=${status}`);
  const [booking, setBooking] = useState(null);
  const [slot, setSlot] = useState(null);
  const book = useAction(() => post(`/waitlist/${booking.id}/book`, { startTime: slot }), { success: 'Appointment booked from the waitlist', invalidate: ['waitlist', 'appointments'], onSuccess: () => { setBooking(null); setSlot(null); } });
  const remove = useAction((e) => post(`/waitlist/${e.id}/remove`, { reason: 'Patient declined' }), { success: 'Removed from waitlist', invalidate: ['waitlist'] });
  return (
    <div>
      <PageHeader way="appointments" title="Waitlist" subtitle="Patients waiting for a slot when a doctor's day was full. First come, first served." />
      <div className="mb-3 flex gap-2">{[['open', 'Waiting'], ['booked', 'Booked'], ['cancelled', 'Removed'], ['all', 'All']].map(([v, l]) => <Button key={v} size="sm" variant={status === v ? 'primary' : 'secondary'} onClick={() => setStatus(v)}>{l}</Button>)}</div>
      <Panel bodyClass="">
        <QueryState query={q}>
          {(r) => (
            <Table rows={r.data} empty={<EmptyState icon={ListOrdered} title="No one is waiting">Patients are added here from the booking page when all of a doctor's slots are taken.</EmptyState>} columns={[
              { header: 'Position', render: (e) => (e.position ? <Token n={e.position} /> : '—'), width: 80 },
              { header: 'Patient', render: (e) => <><p className="font-semibold">{e.patient.fullName}</p><p className="text-xs text-muted">{e.patient.patientCode}, {e.patient.phone}</p></> },
              { header: 'Doctor', render: (e) => <>{e.doctor.fullName}<span className="block text-xs text-muted">{e.doctor.specialization}</span></> },
              { header: 'Wanted date', render: (e) => `${weekday(e.preferredDate)} ${date(e.preferredDate)}` },
              { header: 'Added', render: (e) => relative(e.createdAt) },
              { header: 'Notes', key: 'notes' },
              { header: 'Status', render: (e) => <Status value={e.status} /> },
              { header: '', className: 'text-right', render: (e) => ['waiting', 'notified'].includes(e.status) && <div className="flex justify-end gap-1"><Button size="sm" onClick={() => setBooking(e)}>Book slot</Button><Button size="sm" variant="ghost" onClick={() => remove.mutate(e)}>Remove</Button></div> },
            ]} />
          )}
        </QueryState>
      </Panel>
      <Modal open={Boolean(booking)} onClose={() => setBooking(null)} title={`Book for ${booking?.patient.fullName}`} width="max-w-2xl"
        footer={<><Button variant="secondary" onClick={() => setBooking(null)}>Cancel</Button><Button disabled={!slot} loading={book.isPending} onClick={() => book.mutate()}>Book this slot</Button></>}>
        {booking && <SlotPicker doctorId={booking.doctor.id} date={booking.preferredDate} value={slot} onChange={setSlot} />}
        {book.error && <Callout tone="caution" className="mt-3">{book.error.message}</Callout>}
      </Modal>
    </div>
  );
}

