// Clinical care (SRS 5.6: UC-22..UC-29) — the doctor's workspace.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, BedDouble, FileText, FlaskConical, Pill, Plus, Printer, Save, ShieldAlert, Stethoscope, Trash2 } from 'lucide-react';
import { openFile, post, put, patch, qs } from '../api/client.js';
import { useAction, useApi } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { BackLink, PrintHeader } from '../components/domain.jsx';
import { Button, Callout, Checkbox, EmptyState, Input, KeyValue, Modal, PageHeader, Panel, QueryState, Select, Status, Table, Tabs, Textarea, Token, cx, useForm, useToast } from '../components/ui.jsx';
import { useDraft } from '../lib/drafts.js';
import { addDays, date, dateTime, relative, time, today, titleCase, weekday } from '../lib/format.js';
import { DischargeSummaryModal } from './wards.jsx';

// ----------------------------------------------------------------- schedule
export function DoctorSchedulePage() {
  const [day, setDay] = useState(today());
  const q = useApi(`/appointments${qs({ date: day, pageSize: 200 })}`);
  const nav = useNavigate();
  return (
    <div>
      <PageHeader way="clinical" title="My schedule" subtitle={`${weekday(day)} ${date(day)}`} actions={
        <div className="flex items-center gap-1">
          <Button size="sm" variant="secondary" onClick={() => setDay(addDays(day, -1))} aria-label="Previous day">‹</Button>
          <input type="date" className="field-input w-44" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Date" />
          <Button size="sm" variant="secondary" onClick={() => setDay(addDays(day, 1))} aria-label="Next day">›</Button>
        </div>} />
      <Panel bodyClass="">
        <QueryState query={q}>
          {(r) => (
            <Table rows={r.data.filter((a) => a.status !== 'rescheduled')} empty={<EmptyState icon={Stethoscope} title="No appointments on this day" />} columns={[
              { header: 'Token', render: (a) => <Token n={a.tokenNumber} muted={a.status !== 'scheduled'} />, width: 70 },
              { header: 'Time', render: (a) => <span className="font-semibold tabular-nums">{time(a.startTime)}</span> },
              { header: 'Patient', render: (a) => <><p className="font-semibold">{a.patient.fullName}</p><p className="text-xs text-muted">{a.patient.patientCode}</p></> },
              { header: 'Reason', key: 'reason' },
              { header: 'Status', render: (a) => <Status value={a.status} /> },
              { header: '', className: 'text-right', render: (a) => a.status === 'scheduled' && a.date <= today()
                ? <Button size="sm" onClick={() => nav(`/doctor/patients/${a.patient.id}?appointment=${a.id}`)}>Start consultation</Button>
                : <Button size="sm" variant="ghost" onClick={() => nav(`/doctor/patients/${a.patient.id}`)}>Open record</Button> },
            ]} />
          )}
        </QueryState>
      </Panel>
    </div>
  );
}

// ----------------------------------------------------------------- my patients
export function MyPatientsPage() {
  const [q, setQ] = useState('');
  const mine = useApi(`/clinical/patients${qs({ q })}`);
  const all = useApi(q.trim().length >= 2 ? `/patients${qs({ q, pageSize: 10 })}` : null);
  const nav = useNavigate();
  const mineIds = new Set((mine.data?.data ?? []).map((p) => p.id));
  const others = (all.data?.data ?? []).filter((p) => !mineIds.has(p.id));
  return (
    <div>
      <PageHeader way="clinical" title="My patients" subtitle="Patients you have seen, are booked with you or admitted under your care." />
      <input className="field-input mb-4 max-w-md" placeholder="Search name or patient ID" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search patients" autoFocus />
      <Panel bodyClass="">
        <QueryState query={mine}>
          {(r) => (
            <Table rows={r.data} onRowClick={(p) => nav(`/doctor/patients/${p.id}`)} empty={<EmptyState title="No patients under your care match" />} columns={[
              { header: 'Patient', render: (p) => <><p className="font-semibold">{p.fullName}</p><p className="text-xs text-muted">{p.patientCode}</p></> },
              { header: 'Age / sex', render: (p) => `${p.age} y, ${p.gender}` },
              { header: 'Status', render: (p) => (p.admittedUnderMe ? <Status value="in_patient" label="Admitted under you" /> : <Status value={p.status} />) },
              { header: 'Last seen', render: (p) => (p.lastVisit ? relative(p.lastVisit) : '—') },
              { header: 'Next appointment', render: (p) => (p.nextAppointment ? date(p.nextAppointment) : '—') },
            ]} />
          )}
        </QueryState>
      </Panel>
      {others.length > 0 && (
        <Panel className="mt-5" title="Other patients" subtitle="Not under your care. Opening their record needs emergency access with a reason, which is audited.">
          <ul className="divide-y divide-rule">{others.map((p) => <li key={p.id} className="flex items-center justify-between py-2 text-sm"><span><strong>{p.fullName}</strong> {p.patientCode}, {p.age} y</span><Link className="link" to={`/doctor/patients/${p.id}`}>Open</Link></li>)}</ul>
        </Panel>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- patient chart (UC-22..UC-24)
export function PatientChartPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const q = useApi(`/clinical/patients/${id}/history`);
  const [tab, setTab] = useState(params.get('tab') ?? 'visits');
  const [labOpen, setLabOpen] = useState(false);
  const [admitOpen, setAdmitOpen] = useState(false);
  const [summary, setSummary] = useState(null);
  const appointmentId = params.get('appointment');
  const start = useAction((body) => post('/clinical/visits', body), { onSuccess: (v) => nav(`/doctor/visits/${v.id}`), invalidate: ['clinical', 'reports'] });

  if (q.error?.code === 'NO_CARE_RELATIONSHIP') return <EmergencyAccess patientId={id} onGranted={() => q.refetch()} />;
  return (
    <QueryState query={q}>
      {(h) => {
        const p = h.patient;
        const activeAdmission = h.admissions.find((a) => a.status === 'active');
        const openVisit = h.visits.find((v) => v.status === 'open' && v.isMine);
        return (
          <div>
            <PageHeader way="clinical" back={<BackLink to="/doctor/patients">My patients</BackLink>}
              title={<>{p.fullName} <span className="font-sans text-lg font-normal text-muted">{p.patientCode}</span></>}
              subtitle={`${p.age} years, ${p.gender}${p.bloodGroup ? `, ${p.bloodGroup}` : ''}, ${p.phone}`}
              actions={<>
                <Status value={p.status} />
                {openVisit && <Button onClick={() => nav(`/doctor/visits/${openVisit.id}`)}>Continue open visit</Button>}
                {!openVisit && appointmentId && <Button icon={Stethoscope} loading={start.isPending} onClick={() => start.mutate({ patientId: p.id, appointmentId: Number(appointmentId), visitType: 'opd' })}>Start consultation</Button>}
                {!openVisit && !appointmentId && activeAdmission && <Button icon={Stethoscope} loading={start.isPending} onClick={() => start.mutate({ patientId: p.id, visitType: 'ipd', chiefComplaint: 'Ward round' })}>Ward round note</Button>}
                {!openVisit && !appointmentId && !activeAdmission && <Button icon={Stethoscope} loading={start.isPending} onClick={() => start.mutate({ patientId: p.id, visitType: 'opd', chiefComplaint: 'Walk-in consultation' })}>New consultation</Button>}
                <Button variant="secondary" icon={FlaskConical} onClick={() => setLabOpen(true)}>Request lab test</Button>
                {!activeAdmission && <Button variant="secondary" icon={BedDouble} onClick={() => setAdmitOpen('admission')}>Recommend admission</Button>}
                {activeAdmission && <Button variant="secondary" onClick={() => setAdmitOpen('transfer')}>Request transfer</Button>}
              </>} />
            <div className="mb-4 grid gap-3 md:grid-cols-3">
              <Callout tone={p.allergies ? 'alert' : 'ok'} title={p.allergies ? `Allergies: ${p.allergies}` : 'No known allergies recorded'} />
              <div className="panel p-3 text-sm md:col-span-2"><KeyValue items={[['Medical history', p.medicalHistory], ['Current medications', p.currentMedications]]} /></div>
            </div>
            {activeAdmission && <AdmittedBanner a={activeAdmission} />}
            <Tabs value={tab} onChange={setTab} tabs={[
              { value: 'visits', label: 'Visits', count: h.visits.length },
              { value: 'diagnoses', label: 'Diagnosis log' },
              { value: 'labs', label: 'Lab results' },
              { value: 'admissions', label: 'Admissions', count: h.admissions.length },
            ]} />
            {tab === 'visits' && (h.hasHistory ? <VisitTimeline visits={h.visits} /> : <Panel><EmptyState title="No history available">This patient has no previous visits recorded.</EmptyState></Panel>)}
            {tab === 'diagnoses' && <DiagnosisLog patientId={p.id} />}
            {tab === 'labs' && <LabResults labs={[...h.visits.flatMap((v) => v.labRequests), ...h.otherLabRequests]} />}
            {tab === 'admissions' && <AdmissionsTab admissions={h.admissions} onSummary={setSummary} />}
            {labOpen && <LabRequestModal patientId={p.id} visitId={openVisit?.id} onClose={() => setLabOpen(false)} />}
            {admitOpen && <AdmissionRequestModal patientId={p.id} type={admitOpen} onClose={() => setAdmitOpen(false)} />}
            {summary && <SummaryLoader admissionId={summary} onClose={() => setSummary(null)} />}
          </div>
        );
      }}
    </QueryState>
  );
}

function AdmittedBanner({ a }) {
  const approve = useAction(() => post(`/admissions/${a.id}/approve-discharge`, { notes: '' }), { success: 'Discharge approved; reception and accounts have been notified', invalidate: ['clinical', 'admissions'] });
  return (
    <Callout tone="info" className="mb-4" title={`Admitted to ${a.wardName}, bed ${a.bedNumber}`}
      action={a.dischargeApproved ? <Status value="approved" label="Discharge approved" /> : <Button size="sm" variant="secondary" loading={approve.isPending} onClick={() => approve.mutate()}>Approve discharge</Button>}>
      Since {dateTime(a.admittedAt)}. Reason: {a.reason}
    </Callout>
  );
}

function EmergencyAccess({ patientId, onGranted }) {
  const [reason, setReason] = useState('');
  const grant = useAction(() => post(`/clinical/patients/${patientId}/emergency-access`, { reason }), { success: 'Emergency access granted for 24 hours', onSuccess: onGranted });
  return (
    <div className="max-w-xl">
      <PageHeader way="clinical" title="Patient not under your care" back={<BackLink to="/doctor/patients">My patients</BackLink>} />
      <Panel>
        <Callout tone="caution" title="Emergency access">You can open this record in an emergency. Your name, the time and the reason are written to the audit log and administrators are notified. Access lasts 24 hours.</Callout>
        <Textarea className="mt-4" label="Reason" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} error={grant.error?.fields?.reason} hint="At least 10 characters" />
        <Button className="mt-3" variant="danger" icon={ShieldAlert} disabled={reason.trim().length < 10} loading={grant.isPending} onClick={() => grant.mutate()}>Open record with emergency access</Button>
      </Panel>
    </div>
  );
}

const vitalsText = (o) => [o.temperatureC && `T ${o.temperatureC}°C`, o.pulseBpm && `P ${o.pulseBpm}`, o.systolicBp && `BP ${o.systolicBp}/${o.diastolicBp}`, o.respiratoryRate && `RR ${o.respiratoryRate}`, o.spo2 && `SpO₂ ${o.spo2}%`, o.weightKg && `${o.weightKg} kg`, o.bloodGlucose && `Glucose ${o.bloodGlucose}`].filter(Boolean).join(', ');

function VisitTimeline({ visits }) {
  return (
    <ol className="space-y-4">
      {visits.map((v) => (
        <li key={v.id} className="panel">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule px-4 py-2.5">
            <div>
              <p className="font-sign text-lg font-semibold">{dateTime(v.startedAt)} <span className="text-sm font-normal text-muted">{v.visitType.toUpperCase()} with {v.doctorName}</span></p>
              {v.chiefComplaint && <p className="text-sm text-muted">{v.chiefComplaint}</p>}
            </div>
            <div className="flex items-center gap-2"><Status value={v.status === 'open' ? 'in_progress' : 'completed'} label={v.status === 'open' ? 'Open' : 'Closed'} /><Link to={`/doctor/visits/${v.id}`} className="link text-sm">Full record</Link></div>
          </div>
          <div className="grid gap-4 p-4 text-sm md:grid-cols-2">
            <div>
              <p className="text-xs font-semibold text-muted">Diagnoses</p>
              {v.diagnoses.length ? v.diagnoses.map((d) => <p key={d.id}><strong>{d.conditionName}</strong> <Status value={d.severity} /> <span className="text-muted">{d.notes}</span></p>) : <p className="text-muted">None recorded</p>}
              <p className="mt-2 text-xs font-semibold text-muted">Observations</p>
              {v.observations.length ? v.observations.map((o) => <p key={o.id}>{vitalsText(o)}{o.symptoms ? `. ${o.symptoms}` : ''}</p>) : <p className="text-muted">None recorded</p>}
            </div>
            <div>
              <p className="text-xs font-semibold text-muted">Prescriptions</p>
              {v.prescriptions.length ? v.prescriptions.map((rx) => <div key={rx.id} className="mb-1"><span className="font-semibold">{rx.prescriptionCode}</span> <Status value={rx.status} />{rx.items.map((i) => <p key={i.id} className="text-muted">{i.name} {i.strength}: {i.dosage}, {i.frequency}, {i.durationDays} d</p>)}</div>) : <p className="text-muted">None</p>}
              <p className="mt-2 text-xs font-semibold text-muted">Lab tests</p>
              {v.labRequests.length ? v.labRequests.map((l) => <p key={l.id}>{l.testName} <Status value={l.status} /></p>) : <p className="text-muted">None</p>}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function DiagnosisLog({ patientId }) {
  const q = useApi(`/clinical/patients/${patientId}/diagnoses`);
  return (
    <Panel title="Diagnosis log" subtitle="Read-only. Diagnoses cannot be edited or deleted." bodyClass="">
      <QueryState query={q}>
        {(r) => <Table rows={r.data} empty={<EmptyState title="No diagnosis records found" />} columns={[
          { header: 'Date', render: (d) => dateTime(d.diagnosedAt) }, { header: 'Condition', render: (d) => <><strong>{d.conditionName}</strong>{d.icdCode && <span className="ml-1 text-xs text-muted">{d.icdCode}</span>}</> },
          { header: 'Severity', render: (d) => <Status value={d.severity} /> }, { header: 'Notes', key: 'notes' }, { header: 'Doctor', key: 'doctorName' }, { header: 'Visit', key: 'visitCode' },
        ]} />}
      </QueryState>
    </Panel>
  );
}

export function LabResults({ labs }) {
  const toast = useToast();
  if (!labs.length) return <Panel><EmptyState icon={FlaskConical} title="No lab tests yet" /></Panel>;
  return (
    <div className="space-y-3">
      {labs.map((l) => (
        <Panel key={l.id} title={`${l.testName}`} subtitle={`${l.requestCode}, requested ${dateTime(l.createdAt)}`}
          actions={<><Status value={l.urgency} /><Status value={l.status} />{l.report && <Button size="sm" variant="secondary" icon={FileText} onClick={() => openFile(`/lab/reports/${l.report.id}/file`).catch((e) => toast({ tone: 'alert', title: e.message }))}>View report</Button>}</>}>
          {l.report ? (
            <>
              {l.report.resultValues?.length > 0 && (
                <table className="table-base"><thead><tr><th>Parameter</th><th>Result</th><th>Reference</th><th /></tr></thead>
                  <tbody>{l.report.resultValues.map((r) => <tr key={r.name}><td>{r.name}</td><td className="font-semibold">{r.value} {r.unit}</td><td className="text-muted">{r.referenceRange}</td><td>{r.flag && r.flag !== 'normal' && <Status value={r.flag} tone="alert" label={titleCase(r.flag)} />}</td></tr>)}</tbody></table>
              )}
              {l.report.remarks && <p className="mt-2 text-sm">{l.report.remarks}</p>}
            </>
          ) : <p className="text-sm text-muted">{l.status === 'delayed' ? `Delayed: ${l.delayReason}` : 'The report is not available yet.'}</p>}
        </Panel>
      ))}
    </div>
  );
}

function AdmissionsTab({ admissions, onSummary }) {
  return (
    <Panel bodyClass="">
      <Table rows={admissions} empty={<EmptyState title="No admissions" />} columns={[
        { header: 'Admission', key: 'admissionCode' }, { header: 'Ward / bed', render: (a) => `${a.wardName}, ${a.bedNumber}` },
        { header: 'Admitted', render: (a) => dateTime(a.admittedAt) }, { header: 'Discharged', render: (a) => (a.dischargedAt ? dateTime(a.dischargedAt) : '—') },
        { header: 'Reason', key: 'reason' }, { header: 'Status', render: (a) => <Status value={a.status === 'active' ? 'in_patient' : 'discharged'} /> },
        { header: '', render: (a) => a.hasSummary && <Button size="sm" variant="ghost" onClick={() => onSummary(a.id)}>Summary</Button> },
      ]} />
    </Panel>
  );
}

function SummaryLoader({ admissionId, onClose }) {
  const q = useApi(`/admissions/${admissionId}`);
  if (!q.data) return null;
  return <DischargeSummaryModal s={q.data.dischargeSummary} onClose={onClose} />;
}

function AdmissionRequestModal({ patientId, type, onClose }) {
  const wards = useApi('/wards');
  const f = useForm({ preferredWardId: '', reason: '', priority: 'routine' });
  const save = useAction((v) => post('/admissions/requests', { ...v, patientId, requestType: type }), { success: type === 'admission' ? 'Admission recommended; reception has been notified' : 'Transfer requested', invalidate: ['admissions'], onError: (e) => { f.fromError(e); return Boolean(e.fields); }, onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title={type === 'admission' ? 'Recommend admission' : 'Request transfer'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate(f.values)}>Send to reception</Button></>}>
      <div className="space-y-4">
        <Select label="Preferred ward" placeholder="Any suitable ward" options={(wards.data?.data ?? []).map((w) => ({ value: w.id, label: `${w.name} (${w.availableBeds} free)` }))} {...f.bind('preferredWardId')} />
        <Select label="Priority" options={[{ value: 'routine', label: 'Routine' }, { value: 'urgent', label: 'Urgent' }, { value: 'emergency', label: 'Emergency' }]} {...f.bind('priority')} />
        <Textarea label="Reason" required rows={3} {...f.bind('reason')} />
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------- lab request (UC-28, UC-29)
export function LabRequestModal({ patientId, visitId, onClose }) {
  const tests = useApi('/lab/tests');
  const [testId, setTestId] = useState('');
  const [params, setParams] = useState([]);
  const f = useForm({ urgency: 'routine', clinicalNotes: '', specialInstructions: '' });
  const [unavailable, setUnavailable] = useState(null);
  const test = tests.data?.data.find((t) => t.id === Number(testId));
  useEffect(() => { setParams(test ? test.parameters.map((p) => p.name) : []); setUnavailable(null); }, [testId]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useAction(() => post('/clinical/lab-requests', { patientId, visitId, labTestId: Number(testId), parameters: params, ...f.values }), {
    quietErrors: true, success: 'Lab test requested; the laboratory has been notified', invalidate: ['clinical', 'lab'],
    onError: (e) => { f.fromError(e); if (e.code === 'TEST_UNAVAILABLE') setUnavailable(e); return true; }, onSuccess: onClose,
  });
  const groups = useMemo(() => {
    const g = {};
    for (const t of tests.data?.data ?? []) (g[t.category] ??= []).push(t);
    return g;
  }, [tests.data]);
  return (
    <Modal open onClose={onClose} title="Request lab test" width="max-w-2xl" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button icon={FlaskConical} disabled={!testId || !params.length} loading={save.isPending} onClick={() => save.mutate()}>Send request</Button></>}>
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-semibold">Test<span className="text-alert">*</span></label>
          <select className="field-input" value={testId} onChange={(e) => setTestId(e.target.value)} aria-label="Test">
            <option value="">Choose a test</option>
            {Object.entries(groups).map(([cat, ts]) => <optgroup key={cat} label={cat}>{ts.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isAvailable ? '' : ' (not available)'}</option>)}</optgroup>)}
          </select>
        </div>
        {unavailable && (
          <Callout tone="caution" title={unavailable.message}>
            {unavailable.details.alternatives.length ? <div className="mt-1 flex flex-wrap gap-2">Alternatives: {unavailable.details.alternatives.map((a) => <Button key={a.id} size="sm" variant="secondary" onClick={() => setTestId(String(a.id))}>{a.name}</Button>)}</div> : 'No alternative test is available in this category.'}
          </Callout>
        )}
        {test && (
          <fieldset>
            <legend className="mb-1 text-sm font-semibold">Parameters</legend>
            <p className="mb-2 text-xs text-muted">Choose from the standard parameters for {test.name}. Sample: {test.sampleType}, usual turnaround {test.turnaroundHours} h.</p>
            <div className="grid gap-2 sm:grid-cols-2">{test.parameters.map((p) => <Checkbox key={p.name} label={p.name} hint={[p.unit, p.referenceRange && `ref ${p.referenceRange}`].filter(Boolean).join(', ')} checked={params.includes(p.name)} onChange={(e) => setParams(e.target.checked ? [...params, p.name] : params.filter((x) => x !== p.name))} />)}</div>
            {f.errors.parameters && <p className="mt-1 text-xs font-semibold text-alert">{f.errors.parameters}</p>}
          </fieldset>
        )}
        <Select label="Urgency" required options={[{ value: 'routine', label: 'Routine' }, { value: 'urgent', label: 'Urgent' }, { value: 'stat', label: 'STAT (immediately)' }]} {...f.bind('urgency')} />
        <Textarea label="Clinical notes" required rows={2} {...f.bind('clinicalNotes')} />
        <Input label="Special instructions" placeholder="e.g. fasting sample" {...f.bind('specialInstructions')} />
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------- prescription builder (UC-27)
const blankItem = () => ({ medicineId: '', dosage: '', frequency: '', durationDays: '', quantity: '', instructions: '' });

export function PrescriptionBuilder({ initial, onSubmit, submitting, error, submitLabel = 'Send to pharmacy' }) {
  const meds = useApi('/pharmacy/medicines');
  const [items, setItems] = useState(initial?.length ? initial : [blankItem()]);
  const [notes, setNotes] = useState('');
  const [warnings, setWarnings] = useState(null);
  const set = (i, k, v) => setItems(items.map((it, j) => (j === i ? { ...it, [k]: v } : it)));
  const medById = Object.fromEntries((meds.data?.data ?? []).map((m) => [m.id, m]));
  useEffect(() => { if (error?.code === 'PRESCRIPTION_WARNINGS') setWarnings(error.details.warnings); }, [error]);
  const fieldErr = (i, k) => error?.fields?.[`items.${i}.${k}`];
  const submit = (ack) => onSubmit({ items: items.map((i) => ({ ...i, medicineId: Number(i.medicineId) })), notes, acknowledgeWarnings: ack });
  return (
    <div>
      <div className="space-y-3">
        {items.map((it, i) => {
          const m = medById[it.medicineId];
          return (
            <div key={i} className="rounded border border-rule p-3">
              <div className="grid gap-3 md:grid-cols-[2fr_1fr_1.4fr_0.8fr_0.8fr_auto]">
                <div>
                  <label className="mb-1 block text-xs font-semibold">Medicine</label>
                  <select className="field-input" value={it.medicineId} onChange={(e) => set(i, 'medicineId', e.target.value)} aria-label="Medicine" aria-invalid={Boolean(fieldErr(i, 'medicineId'))}>
                    <option value="">Choose</option>
                    {(meds.data?.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name} {x.strength} ({x.form}) — {x.outOfStock ? 'out of stock' : `${x.stock} in stock`}</option>)}
                  </select>
                </div>
                <Input label="Dosage" placeholder="500 mg" value={it.dosage} onChange={(e) => set(i, 'dosage', e.target.value)} error={fieldErr(i, 'dosage')} />
                <Input label="Frequency" placeholder="Twice daily" value={it.frequency} onChange={(e) => set(i, 'frequency', e.target.value)} error={fieldErr(i, 'frequency')} />
                <Input label="Days" type="number" min="1" value={it.durationDays} onChange={(e) => set(i, 'durationDays', e.target.value)} error={fieldErr(i, 'durationDays')} />
                <Input label="Quantity" type="number" min="1" value={it.quantity} onChange={(e) => set(i, 'quantity', e.target.value)} error={fieldErr(i, 'quantity')} />
                <Button variant="ghost" icon={Trash2} className="self-end" disabled={items.length === 1} onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label="Remove medicine" />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <input className="field-input flex-1 py-1.5 text-sm" placeholder="Instructions, e.g. after food" value={it.instructions} onChange={(e) => set(i, 'instructions', e.target.value)} aria-label="Instructions" />
                {m && <span className={cx('text-xs font-semibold', m.stock < Number(it.quantity || 1) ? 'text-alert' : 'text-ok')}>{m.stock} in stock</span>}
              </div>
            </div>
          );
        })}
      </div>
      <Button size="sm" variant="quiet" icon={Plus} className="mt-2" onClick={() => setItems([...items, blankItem()])}>Add medicine</Button>
      <Textarea className="mt-3" label="Notes for the pharmacist" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      {error && error.code !== 'PRESCRIPTION_WARNINGS' && !Object.keys(error.fields ?? {}).length && <Callout tone="alert" className="mt-3">{error.message}</Callout>}
      <div className="mt-3 flex justify-end"><Button icon={Pill} loading={submitting} onClick={() => submit(false)} disabled={items.some((i) => !i.medicineId)}>{submitLabel}</Button></div>
      <Modal open={Boolean(warnings)} onClose={() => setWarnings(null)} title="Check before sending" width="max-w-xl"
        footer={<><Button variant="secondary" onClick={() => setWarnings(null)}>Change prescription</Button><Button variant="danger" onClick={() => { setWarnings(null); submit(true); }}>Send anyway</Button></>}>
        <ul className="space-y-3">
          {warnings?.map((w, k) => (
            <li key={k}>
              <Callout tone={w.type === 'allergy' ? 'alert' : 'caution'} title={w.type === 'allergy' ? `Allergy warning: ${w.medicine}` : `${w.medicine}: only ${w.available} in stock (needs ${w.requested})`}>
                {w.type === 'allergy' ? w.message : w.alternatives?.length ? (
                  <div className="mt-1 flex flex-wrap items-center gap-2">Available alternatives:
                    {w.alternatives.map((a) => <Button key={a.id} size="sm" variant="secondary" onClick={() => { setItems(items.map((it) => (Number(it.medicineId) === w.medicineId ? { ...it, medicineId: String(a.id) } : it))); setWarnings(null); }}>{a.name} {a.strength} ({a.stock})</Button>)}
                  </div>
                ) : 'No alternative is in stock.'}
              </Callout>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}

// ----------------------------------------------------------------- visit workspace (UC-23, UC-25..UC-28)
export function VisitPage() {
  const { id } = useParams();
  const q = useApi(`/clinical/visits/${id}`);
  const nav = useNavigate();
  const close = useAction((notes) => post(`/clinical/visits/${id}/close`, { notes }), { success: 'Visit closed', invalidate: ['clinical', 'appointments', 'reports'], onSuccess: () => nav('/doctor/schedule') });
  const [labOpen, setLabOpen] = useState(false);
  const [printing, setPrinting] = useState(false);
  return (
    <QueryState query={q}>
      {(v) => {
        const editable = v.status === 'open';
        return (
          <div>
            <PageHeader way="clinical" back={<BackLink to={`/doctor/patients/${v.patient.id}`}>{v.patient.fullName}</BackLink>}
              title={`${v.visitType === 'ipd' ? 'Ward' : v.visitType === 'emergency' ? 'Emergency' : 'OPD'} visit — ${v.patient.fullName}`}
              subtitle={`${v.visitCode}, started ${dateTime(v.startedAt)} by ${v.doctorName}`}
              actions={<>
                <Status value={editable ? 'in_progress' : 'completed'} label={editable ? 'Open' : 'Closed'} />
                <Button variant="secondary" icon={Printer} onClick={() => setPrinting(true)}>Print record</Button>
                {editable && v.isMine && <Button onClick={() => close.mutate(undefined)} loading={close.isPending}>Finish visit</Button>}
              </>} />
            <Callout tone={v.patient.allergies ? 'alert' : 'ok'} className="mb-4" title={v.patient.allergies ? `Allergies: ${v.patient.allergies}` : 'No known allergies recorded'} />
            {!editable && <Callout tone="info" className="mb-4">This visit is closed and read-only. Start a new consultation from the patient's record to add notes.</Callout>}
            <div className="grid gap-5 xl:grid-cols-2">
              <div className="space-y-5">
                <NotesPanel v={v} editable={editable && v.isMine} />
                <ObservationsPanel v={v} editable={editable} />
                <DiagnosisPanel v={v} editable={editable} />
              </div>
              <div className="space-y-5">
                <Panel title="Prescriptions" subtitle={editable ? 'A diagnosis must be recorded for this visit before prescribing.' : undefined}>
                  {v.prescriptions.map((rx) => (
                    <div key={rx.id} className="mb-3 rounded border border-rule p-3 text-sm">
                      <p className="flex items-center justify-between"><strong>{rx.prescriptionCode}</strong><Status value={rx.status} /></p>
                      {rx.flagReason && rx.status === 'flagged' && <p className="mt-1 text-alert">Pharmacy: {rx.flagReason}</p>}
                      <ul className="mt-1">{rx.items.map((i) => <li key={i.id}>{i.name} {i.strength} — {i.dosage}, {i.frequency}, {i.durationDays} days (qty {i.quantity}){i.instructions ? `. ${i.instructions}` : ''}</li>)}</ul>
                    </div>
                  ))}
                  {editable && <NewPrescription visitId={v.id} hasDiagnosis={v.diagnoses.length > 0} />}
                  {!editable && v.prescriptions.length === 0 && <p className="text-sm text-muted">No prescriptions.</p>}
                </Panel>
                <Panel title="Lab tests" actions={<Button size="sm" variant="secondary" icon={FlaskConical} onClick={() => setLabOpen(true)}>Request test</Button>}>
                  {v.labRequests.length === 0 ? <p className="text-sm text-muted">No lab tests requested in this visit.</p> : <LabResults labs={v.labRequests} />}
                </Panel>
              </div>
            </div>
            {labOpen && <LabRequestModal patientId={v.patient.id} visitId={v.id} onClose={() => setLabOpen(false)} />}
            {printing && <PrintRecord v={v} onClose={() => setPrinting(false)} />}
          </div>
        );
      }}
    </QueryState>
  );
}

function NotesPanel({ v, editable }) {
  const f = useForm({ chiefComplaint: v.chiefComplaint ?? '', notes: v.notes ?? '' });
  const draft = useDraft(editable ? `visit-notes-${v.id}` : null, f.values, { enabled: editable });
  const save = useAction((vals) => patch(`/clinical/visits/${v.id}`, vals), { success: 'Notes saved', invalidate: ['clinical'], onSuccess: () => draft.clear() });
  return (
    <Panel title="Consultation notes" actions={editable && <Button size="sm" icon={Save} loading={save.isPending} onClick={() => save.mutate(f.values)}>Save notes</Button>}>
      {draft.draft && <Callout tone="info" className="mb-3" title="Unsaved notes found" action={<Button size="sm" onClick={() => { f.setValues(draft.draft.data); draft.dismiss(); }}>Restore</Button>}>Saved automatically {relative(draft.draft.updatedAt)}.</Callout>}
      {editable ? (
        <div className="space-y-3">
          <Input label="Chief complaint" {...f.bind('chiefComplaint')} />
          <Textarea label="Examination and plan" rows={5} {...f.bind('notes')} hint="Saved as a draft automatically while you type." />
        </div>
      ) : <KeyValue cols={1} items={[['Chief complaint', v.chiefComplaint], ['Notes', v.notes && <span className="whitespace-pre-wrap">{v.notes}</span>]]} />}
    </Panel>
  );
}

const VITALS = [['temperatureC', 'Temp (°C)', '0.1'], ['pulseBpm', 'Pulse (bpm)'], ['systolicBp', 'BP systolic'], ['diastolicBp', 'BP diastolic'], ['respiratoryRate', 'Resp. rate'], ['spo2', 'SpO₂ (%)'], ['weightKg', 'Weight (kg)', '0.1'], ['heightCm', 'Height (cm)', '0.1'], ['bloodGlucose', 'Glucose (mg/dL)', '0.1']];

function ObservationsPanel({ v, editable }) {
  const empty = Object.fromEntries([...VITALS.map(([k]) => [k, '']), ['symptoms', ''], ['notes', '']]);
  const f = useForm(empty);
  const save = useAction((vals) => post(`/clinical/visits/${v.id}/observations`, vals), { success: 'Observations recorded', invalidate: ['clinical'], onError: (e) => { f.fromError(e); return Boolean(e.fields); }, onSuccess: () => f.reset() });
  return (
    <Panel title="Observations" subtitle="Vitals and symptoms, recorded with time and your name.">
      {v.observations.map((o) => <p key={o.id} className="mb-2 border-b border-rule/70 pb-2 text-sm"><span className="text-xs text-muted">{dateTime(o.recordedAt)}, {o.doctorName}</span><br />{vitalsText(o)}{o.symptoms ? `. ${o.symptoms}` : ''}</p>)}
      {editable && (
        <form onSubmit={(e) => { e.preventDefault(); save.mutate(f.values); }} noValidate>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{VITALS.map(([k, label, step]) => <Input key={k} label={label} type="number" step={step ?? '1'} {...f.bind(k)} />)}</div>
          <Textarea className="mt-3" label="Symptoms" rows={2} {...f.bind('symptoms')} />
          <div className="mt-3 flex justify-end"><Button type="submit" variant="secondary" loading={save.isPending}>Record observations</Button></div>
        </form>
      )}
    </Panel>
  );
}

function DiagnosisPanel({ v, editable }) {
  const f = useForm({ conditionName: '', icdCode: '', severity: '', notes: '' });
  const save = useAction((vals) => post(`/clinical/visits/${v.id}/diagnoses`, vals), { success: 'Diagnosis recorded', invalidate: ['clinical'], onError: (e) => { f.fromError(e); return Boolean(e.fields); }, onSuccess: () => f.reset() });
  return (
    <Panel title="Diagnosis" subtitle="Diagnoses are permanent and cannot be edited or deleted.">
      {v.diagnoses.map((d) => <p key={d.id} className="mb-2 border-b border-rule/70 pb-2 text-sm"><strong>{d.conditionName}</strong> {d.icdCode && <span className="text-xs text-muted">{d.icdCode}</span>} <Status value={d.severity} /><br /><span className="text-muted">{d.notes}</span></p>)}
      {editable && (
        <form className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]" onSubmit={(e) => { e.preventDefault(); save.mutate(f.values); }} noValidate>
          <Input label="Condition" required {...f.bind('conditionName')} />
          <Input label="ICD-10 code" {...f.bind('icdCode')} />
          <Select label="Severity" required placeholder="Choose" options={['mild', 'moderate', 'severe', 'critical'].map((s) => ({ value: s, label: titleCase(s) }))} {...f.bind('severity')} />
          <Textarea label="Notes" required rows={2} className="sm:col-span-3" {...f.bind('notes')} />
          <div className="flex justify-end sm:col-span-3"><Button type="submit" variant="secondary" loading={save.isPending}>Add diagnosis</Button></div>
        </form>
      )}
    </Panel>
  );
}

function NewPrescription({ visitId, hasDiagnosis }) {
  const [key, setKey] = useState(0);
  const save = useAction((body) => post(`/clinical/visits/${visitId}/prescriptions`, body), { quietErrors: true, onError: () => true, success: 'Prescription sent to the pharmacy', invalidate: ['clinical', 'pharmacy'], onSuccess: () => setKey((k) => k + 1) });
  if (!hasDiagnosis) return <Callout tone="caution" title="Record a diagnosis first">Prescriptions require a diagnosis for this visit.</Callout>;
  return <PrescriptionBuilder key={key} onSubmit={(b) => save.mutate(b)} submitting={save.isPending} error={save.error} />;
}

function PrintRecord({ v, onClose }) {
  return (
    <Modal open onClose={onClose} title="Medical record" width="max-w-3xl" footer={<><Button variant="secondary" icon={Printer} onClick={() => window.print()}>Print or save as PDF</Button><Button onClick={onClose}>Close</Button></>}>
      <div className="print-sheet text-sm">
        <PrintHeader title="Medical record" subtitle={v.visitCode} />
        <KeyValue cols={3} items={[['Patient', `${v.patient.fullName} (${v.patient.patientCode})`], ['Age / sex', `${v.patient.age} y, ${v.patient.gender}`], ['Allergies', v.patient.allergies ?? 'None recorded'], ['Visit', `${v.visitType.toUpperCase()}, ${dateTime(v.startedAt)}`], ['Doctor', `${v.doctorName}, ${v.specialization}`], ['Complaint', v.chiefComplaint]]} />
        {v.notes && <><h3 className="mt-4 text-lg font-semibold">Notes</h3><p className="whitespace-pre-wrap">{v.notes}</p></>}
        <h3 className="mt-4 text-lg font-semibold">Observations</h3>{v.observations.length ? v.observations.map((o) => <p key={o.id}>{dateTime(o.recordedAt)}: {vitalsText(o)}{o.symptoms ? `. ${o.symptoms}` : ''}</p>) : <p>None</p>}
        <h3 className="mt-4 text-lg font-semibold">Diagnoses</h3>{v.diagnoses.length ? v.diagnoses.map((d) => <p key={d.id}>{d.conditionName} ({d.severity}). {d.notes}</p>) : <p>None</p>}
        <h3 className="mt-4 text-lg font-semibold">Prescriptions</h3>{v.prescriptions.length ? v.prescriptions.flatMap((rx) => rx.items.map((i) => <p key={i.id}>{i.name} {i.strength}: {i.dosage}, {i.frequency}, {i.durationDays} days</p>)) : <p>None</p>}
        <h3 className="mt-4 text-lg font-semibold">Investigations</h3>{v.labRequests.length ? v.labRequests.map((l) => <p key={l.id}>{l.testName}: {l.status}</p>) : <p>None</p>}
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------- flagged prescriptions (UC-34 2-A)
export function FlaggedPrescriptionsPage() {
  const q = useApi('/clinical/prescriptions/flagged');
  const [revising, setRevising] = useState(null);
  return (
    <div>
      <PageHeader way="clinical" title="Flagged prescriptions" subtitle="The pharmacy found a problem with these prescriptions. Correct and resend them." />
      <Panel bodyClass="">
        <QueryState query={q}>
          {(r) => <Table rows={r.data} empty={<EmptyState icon={Pill} title="Nothing flagged">The pharmacy has no open questions about your prescriptions.</EmptyState>} columns={[
            { header: 'Prescription', key: 'prescriptionCode' },
            { header: 'Patient', render: (x) => <Link className="link" to={`/doctor/patients/${x.patient.id}`}>{x.patient.fullName}</Link> },
            { header: 'Pharmacy says', render: (x) => <span className="text-alert"><AlertTriangle className="mr-1 inline h-4 w-4" />{x.flagReason}</span> },
            { header: 'Flagged', render: (x) => <>{relative(x.flaggedAt)}<span className="block text-xs text-muted">{x.flaggedByName}</span></> },
            { header: '', className: 'text-right', render: (x) => <Button size="sm" onClick={() => setRevising(x)}>Revise</Button> },
          ]} />}
        </QueryState>
      </Panel>
      {revising && <ReviseModal rx={revising} onClose={() => setRevising(null)} />}
    </div>
  );
}

function ReviseModal({ rx, onClose }) {
  const visit = useApi(`/clinical/visits/${rx.visitId}`);
  const save = useAction((body) => put(`/clinical/prescriptions/${rx.id}`, body), { quietErrors: true, onError: () => true, success: 'Prescription revised and resent', invalidate: ['clinical', 'pharmacy'], onSuccess: onClose });
  const cancel = useAction(() => post(`/clinical/prescriptions/${rx.id}/cancel`, { reason: 'Withdrawn after pharmacy query' }), { success: 'Prescription cancelled', invalidate: ['clinical', 'pharmacy'], onSuccess: onClose });
  const current = visit.data?.prescriptions.find((p) => p.id === rx.id);
  return (
    <Modal open onClose={onClose} title={`Revise ${rx.prescriptionCode}`} width="max-w-4xl" footer={<Button variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate()}>Withdraw prescription</Button>}>
      <Callout tone="alert" className="mb-4" title="Pharmacy query">{rx.flagReason}</Callout>
      {current ? <PrescriptionBuilder initial={current.items.map((i) => ({ medicineId: String(i.medicineId), dosage: i.dosage, frequency: i.frequency, durationDays: i.durationDays, quantity: i.quantity, instructions: i.instructions ?? '' }))} onSubmit={(b) => save.mutate(b)} submitting={save.isPending} error={save.error} submitLabel="Resend to pharmacy" /> : <p className="text-sm text-muted">Loading…</p>}
    </Modal>
  );
}
