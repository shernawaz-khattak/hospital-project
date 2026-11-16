// Ward & bed management (SRS 5.5: UC-18 Admit, UC-19 Assign Bed, UC-20 Transfer, UC-21 Discharge).
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowRightLeft, BedDouble, CheckCircle2, LogOut, Plus, Printer, Trash2, Wrench } from 'lucide-react';
import { api, del, patch, post, qs } from '../api/client.js';
import { useAction, useApi } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { BackLink, DoctorSelect, PatientPicker, PrintHeader } from '../components/domain.jsx';
import { Button, Callout, Checkbox, EmptyState, Input, KeyValue, Modal, PageHeader, Panel, QueryState, Select, Status, Table, Tabs, Textarea, cx, useConfirm, useForm } from '../components/ui.jsx';
import { date, dateTime, money, relative, titleCase } from '../lib/format.js';

const WARD_TYPES = ['general', 'private', 'semi_private', 'icu', 'maternity', 'pediatric', 'surgical', 'emergency'];

// ----------------------------------------------------------------- bed board (live)
export function BedBoardPage() {
  const wards = useApi('/wards');
  const board = useApi('/wards/board');
  const { can, user } = useAuth();
  const nav = useNavigate();
  const [wardId, setWardId] = useState('');
  const beds = (board.data?.data ?? []).filter((b) => !wardId || b.wardId === Number(wardId));
  const grouped = useMemo(() => {
    const m = new Map();
    for (const b of beds) {
      if (!m.has(b.wardId)) m.set(b.wardId, { name: b.wardName, beds: [] });
      m.get(b.wardId).beds.push(b);
    }
    return [...m.entries()];
  }, [beds]);
  const totals = (wards.data?.data ?? []).reduce((t, w) => ({ a: t.a + w.availableBeds, o: t.o + w.occupiedBeds, m: t.m + w.maintenanceBeds }), { a: 0, o: 0, m: 0 });
  return (
    <div>
      <PageHeader way="wards" title="Bed board" subtitle={`${totals.a} available, ${totals.o} occupied, ${totals.m} under maintenance. Updates live as beds change.`}
        actions={<>{can('admissions.manage') && <Link to="/admissions/new"><Button icon={BedDouble}>Admit patient</Button></Link>}</>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select className="field-input w-64" value={wardId} onChange={(e) => setWardId(e.target.value)} aria-label="Ward">
          <option value="">All wards</option>
          {(wards.data?.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name} ({w.availableBeds} free)</option>)}
        </select>
        <span className="flex items-center gap-3 text-xs text-muted">
          <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-sm border border-ok/40 bg-ok-light" />Available</span>
          <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-sm bg-way-wards" />Occupied</span>
          <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-sm border border-caution/40 bg-caution-light" />Maintenance</span>
        </span>
      </div>
      <QueryState query={board}>
        {() => (
          <div className="space-y-5">
            {grouped.map(([id, w]) => {
              const meta = wards.data?.data.find((x) => x.id === id);
              return (
                <Panel key={id} title={w.name} subtitle={meta && `${titleCase(meta.wardType)} ward, floor ${meta.floor ?? '—'}, ${money(meta.dailyRate)} per day${meta.genderPolicy !== 'any' ? `, ${meta.genderPolicy} patients only` : ''}`}
                  actions={meta && <span className="text-sm"><strong>{meta.availableBeds}</strong> of {meta.totalBeds} free</span>}>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
                    {w.beds.map((b) => (
                      <button key={b.id} type="button" disabled={!b.occupant && !can('admissions.manage')}
                        onClick={() => (b.occupant ? nav(user.role === 'doctor' ? `/doctor/patients/${b.occupant.patientId}` : `/admissions/${b.occupant.admissionId}`) : b.status === 'available' ? nav(`/admissions/new?wardId=${b.wardId}&bedId=${b.id}`) : null)}
                        className={cx('min-h-[84px] rounded border p-2.5 text-left text-sm transition-colors disabled:cursor-default',
                          b.status === 'occupied' ? 'border-way-wards bg-way-wards text-white hover:brightness-110' : b.status === 'maintenance' ? 'border-caution/30 bg-caution-light' : 'border-ok/30 bg-ok-light hover:border-ok')}>
                        <span className="flex items-center justify-between font-sign text-lg font-semibold">{b.bedNumber}{b.occupant?.dischargeApproved && <CheckCircle2 className="h-4 w-4" aria-label="Discharge approved" />}</span>
                        {b.occupant ? (
                          <span className="block leading-tight"><span className="block truncate font-semibold">{b.occupant.fullName}</span><span className="block text-xs opacity-85">{b.occupant.age} y, {b.occupant.doctorName}</span></span>
                        ) : <span className="text-xs">{b.status === 'maintenance' ? b.notes || 'Maintenance' : 'Free'}</span>}
                      </button>
                    ))}
                  </div>
                </Panel>
              );
            })}
          </div>
        )}
      </QueryState>
    </div>
  );
}

// ----------------------------------------------------------------- ward setup
export function WardsConfigPage() {
  const q = useApi('/wards?includeInactive=true');
  const board = useApi('/wards/board');
  const deps = useApi('/departments');
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(null);
  const confirm = useConfirm();
  const bedStatus = useAction(({ id, status }) => patch(`/wards/beds/${id}`, { status }), { success: 'Bed status updated', invalidate: ['wards'] });
  const removeBed = useAction((bed) => del(`/wards/beds/${bed.id}`), { success: 'Bed permanently deleted', invalidate: ['wards'] });
  return (
    <div>
      <PageHeader way="wards" title="Wards & beds" subtitle="Ward setup, daily room rates and bed availability." actions={<Button icon={Plus} onClick={() => setEditing({})}>Add ward</Button>} />
      <QueryState query={q}>
        {(r) => (
          <div className="space-y-4">
            {r.data.map((w) => (
              <Panel key={w.id} title={w.name} subtitle={`${titleCase(w.wardType)}, ${w.departmentName ?? 'no department'}, ${money(w.dailyRate)}/day${w.genderPolicy !== 'any' ? `, ${w.genderPolicy} only` : ''}`}
                actions={<><Status value={w.isActive ? 'active' : 'inactive'} /><Button size="sm" variant="secondary" onClick={() => setAdding(w)}>Add beds</Button><Button size="sm" variant="ghost" onClick={() => setEditing(w)}>Edit</Button></>}>
                <div className="flex flex-wrap gap-2">
                  {(board.data?.data ?? []).filter((b) => b.wardId === w.id).map((b) => (
                    <span key={b.id} className="inline-flex items-center gap-1.5 rounded border border-rule px-2 py-1 text-sm">
                      <strong>{b.bedNumber}</strong> <Status value={b.status} />
                      {b.status !== 'occupied' && (
                        <>
                          <button className="text-muted hover:text-ink" title={b.status === 'available' ? 'Mark under maintenance' : 'Mark available'} aria-label={`Toggle maintenance for ${b.bedNumber}`}
                            onClick={() => bedStatus.mutate({ id: b.id, status: b.status === 'available' ? 'maintenance' : 'available' })}><Wrench className="h-3.5 w-3.5" /></button>
                          <button className="text-muted hover:text-alert" title={`Permanently delete ${b.bedNumber}`} aria-label={`Permanently delete ${b.bedNumber}`}
                            onClick={async () => (await confirm({ title: `Permanently delete ${b.bedNumber}?`, danger: true, confirmLabel: 'Delete bed', message: 'This bed will be permanently removed. Beds with any admission or transfer history cannot be deleted.' })) && removeBed.mutate(b)}><Trash2 className="h-3.5 w-3.5" /></button>
                        </>
                      )}
                    </span>
                  ))}
                  {w.totalBeds === 0 && <span className="text-sm text-muted">No beds yet.</span>}
                </div>
              </Panel>
            ))}
          </div>
        )}
      </QueryState>
      {editing && <WardForm ward={editing} deps={deps.data?.data ?? []} onClose={() => setEditing(null)} />}
      {adding && <AddBeds ward={adding} onClose={() => setAdding(null)} />}
    </div>
  );
}

function WardForm({ ward, deps, onClose }) {
  const f = useForm({ name: ward.name ?? '', wardType: ward.wardType ?? 'general', departmentId: ward.departmentId ?? '', floor: ward.floor ?? '', genderPolicy: ward.genderPolicy ?? 'any', dailyRate: ward.dailyRate ?? '', bedCount: '', isActive: ward.isActive ?? true });
  const save = useAction((v) => {
    const { bedCount, isActive, ...rest } = v;
    return ward.id ? patch(`/wards/${ward.id}`, { ...rest, isActive }) : post('/wards', { ...rest, bedCount: bedCount || undefined });
  }, { success: 'Ward saved', invalidate: ['wards'], onError: (e) => { f.fromError(e); return Boolean(e.fields); }, onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title={ward.id ? `Edit ${ward.name}` : 'Add ward'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="ward-form" loading={save.isPending}>Save</Button></>}>
      <form id="ward-form" className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(f.values); }} noValidate>
        <Input label="Ward name" required className="sm:col-span-2" {...f.bind('name')} />
        <Select label="Type" options={WARD_TYPES.map((t) => ({ value: t, label: titleCase(t) }))} {...f.bind('wardType')} />
        <Select label="Department" placeholder="None" options={deps.map((d) => ({ value: d.id, label: d.name }))} {...f.bind('departmentId')} />
        <Input label="Floor" {...f.bind('floor')} />
        <Select label="Admits" options={[{ value: 'any', label: 'All patients' }, { value: 'male', label: 'Male only' }, { value: 'female', label: 'Female only' }]} {...f.bind('genderPolicy')} />
        <Input label="Daily room rate" type="number" min="0" required {...f.bind('dailyRate')} />
        {!ward.id && <Input label="Number of beds" type="number" min="0" max="100" {...f.bind('bedCount')} />}
        {ward.id && <Checkbox label="Ward in use" hint="A ward with admitted patients cannot be closed." {...f.bind('isActive', { type: 'checkbox' })} />}
      </form>
    </Modal>
  );
}

function AddBeds({ ward, onClose }) {
  const f = useForm({ count: 1, prefix: '' });
  const save = useAction((v) => post(`/wards/${ward.id}/beds`, { count: Number(v.count), prefix: v.prefix || undefined }), { success: 'Beds added', invalidate: ['wards'], onError: (e) => { f.fromError(e); return Boolean(e.fields); }, onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title={`Add beds to ${ward.name}`} width="max-w-md" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate(f.values)} loading={save.isPending}>Add beds</Button></>}>
      <div className="grid grid-cols-2 gap-4"><Input label="How many" type="number" min="1" max="50" {...f.bind('count')} /><Input label="Bed number prefix" hint="Optional" {...f.bind('prefix')} /></div>
    </Modal>
  );
}

// ----------------------------------------------------------------- admissions list & requests
export function AdmissionsPage() {
  const [tab, setTab] = useState('active');
  const [search, setSearch] = useState('');
  const list = useApi(`/admissions${qs({ status: tab === 'requests' ? 'active' : tab, q: search })}`);
  const requests = useApi('/admissions/requests');
  const nav = useNavigate();
  const cancelReq = useAction((id) => post(`/admissions/requests/${id}/cancel`), { success: 'Request cancelled', invalidate: ['admissions'] });
  return (
    <div>
      <PageHeader way="wards" title="Admissions" actions={<Link to="/admissions/new"><Button icon={BedDouble}>Admit patient</Button></Link>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'active', label: 'Admitted now' }, { value: 'requests', label: 'Doctor requests', count: requests.data?.data.length }, { value: 'discharged', label: 'Discharged' }]} />
      {tab === 'requests' ? (
        <Panel bodyClass="">
          <QueryState query={requests}>
            {(r) => <Table rows={r.data} empty={<EmptyState title="No pending requests">Admission and transfer recommendations from doctors appear here.</EmptyState>} columns={[
              { header: 'Type', render: (x) => titleCase(x.requestType) },
              { header: 'Priority', render: (x) => <Status value={x.priority} /> },
              { header: 'Patient', render: (x) => <><p className="font-semibold">{x.patient.fullName}</p><p className="text-xs text-muted">{x.patient.patientCode}</p></> },
              { header: 'Doctor', render: (x) => x.doctor.fullName },
              { header: 'Preferred ward', render: (x) => x.preferredWardName ?? 'Any' },
              { header: 'Reason', key: 'reason' },
              { header: 'Requested', render: (x) => relative(x.createdAt) },
              { header: '', className: 'text-right', render: (x) => <div className="flex justify-end gap-1">
                {x.requestType === 'admission' ? <Button size="sm" onClick={() => nav(`/admissions/new?patientId=${x.patient.id}&requestId=${x.id}${x.preferredWardId ? `&wardId=${x.preferredWardId}` : ''}&doctorId=${x.doctor.id}&reason=${encodeURIComponent(x.reason)}`)}>Admit</Button>
                  : <Button size="sm" onClick={() => api(`/admissions${qs({ q: x.patient.patientCode })}`).then((r2) => r2.data[0] && nav(`/admissions/${r2.data[0].id}?transfer=${x.id}`))}>Transfer</Button>}
                <Button size="sm" variant="ghost" onClick={() => cancelReq.mutate(x.id)}>Cancel</Button></div> },
            ]} />}
          </QueryState>
        </Panel>
      ) : (
        <Panel bodyClass="">
          <div className="border-b border-rule p-3"><input className="field-input max-w-sm" placeholder="Patient name, ID or admission number" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search admissions" /></div>
          <QueryState query={list}>
            {(r) => <Table rows={r.data} onRowClick={(a) => nav(`/admissions/${a.id}`)} empty={<EmptyState icon={BedDouble} title={tab === 'active' ? 'No patients are admitted' : 'No discharges found'} />} columns={[
              { header: 'Admission', render: (a) => <span className="font-semibold">{a.admissionCode}</span> },
              { header: 'Patient', render: (a) => <><p className="font-semibold">{a.patient.fullName}</p><p className="text-xs text-muted">{a.patient.patientCode}, {a.patient.age} y</p></> },
              { header: 'Ward / bed', render: (a) => `${a.ward.name}, ${a.bed.bedNumber}` },
              { header: 'Doctor', render: (a) => a.doctor.fullName },
              { header: tab === 'active' ? 'Admitted' : 'Discharged', render: (a) => dateTime(tab === 'active' ? a.admittedAt : a.dischargedAt) },
              { header: 'Status', render: (a) => (a.status === 'active' && a.dischargeApprovedAt ? <Status value="approved" label="Ready for discharge" /> : <Status value={a.status === 'active' ? 'in_patient' : 'discharged'} />) },
            ]} />}
          </QueryState>
        </Panel>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- admit (UC-18 / UC-19)
function BedChooser({ wardId, value, onChange, gender }) {
  const board = useApi(wardId ? `/wards/board?wardId=${wardId}` : null);
  if (!wardId) return <p className="text-sm text-muted">Choose a ward to see its beds.</p>;
  return (
    <QueryState query={board}>
      {(r) => (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6" role="radiogroup" aria-label="Bed">
          {r.data.map((b) => (
            <button key={b.id} type="button" role="radio" aria-checked={value === b.id} disabled={b.status !== 'available'} onClick={() => onChange(b.id)}
              className={cx('rounded border px-2 py-2 text-sm font-semibold', value === b.id ? 'border-scrub bg-scrub text-white' : b.status === 'available' ? 'border-ok/40 bg-ok-light hover:border-ok' : 'cursor-not-allowed border-transparent bg-ink/5 text-muted line-through')}>
              {b.bedNumber}
            </button>
          ))}
        </div>
      )}
    </QueryState>
  );
}

export function AdmitPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const wards = useApi('/wards');
  const [patient, setPatient] = useState(null);
  const [wardId, setWardId] = useState(params.get('wardId') ?? '');
  const [bedId, setBedId] = useState(params.get('bedId') ? Number(params.get('bedId')) : null);
  const [doctorId, setDoctorId] = useState(params.get('doctorId') ? Number(params.get('doctorId')) : null);
  const [reason, setReason] = useState(params.get('reason') ?? '');
  const [err, setErr] = useState(null);
  useEffect(() => { const pid = params.get('patientId'); if (pid) api(`/patients/${pid}`).then(setPatient).catch(() => {}); }, [params]);
  const admit = useAction((b) => post('/admissions', b), { quietErrors: true, onError: (e) => { setErr(e); return true; }, onSuccess: (a) => nav(`/admissions/${a.id}`), success: 'Patient admitted and bed assigned', invalidate: ['wards', 'admissions', 'patients', 'reports'] });
  const selectedWard = wards.data?.data.find((w) => w.id === Number(wardId));
  return (
    <div className="max-w-4xl">
      <PageHeader way="wards" title="Admit patient" subtitle="The patient becomes an in-patient and the bed is marked occupied for every user immediately." back={<BackLink to="/admissions">Admissions</BackLink>} />
      <Panel>
        <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); setErr(null); admit.mutate({ patientId: patient?.id, wardId: Number(wardId), bedId, attendingDoctorId: doctorId, reason, requestId: params.get('requestId') ? Number(params.get('requestId')) : undefined }); }} noValidate>
          <PatientPicker value={patient} onChange={setPatient} required error={err?.fields?.patientId} />
          {patient?.status === 'in_patient' && <Callout tone="caution">This patient is already admitted.</Callout>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label="Ward" required placeholder="Choose a ward" value={wardId} onChange={(e) => { setWardId(e.target.value); setBedId(null); setErr(null); }} error={err?.fields?.wardId}
              options={(wards.data?.data ?? []).map((w) => ({ value: w.id, label: `${w.name} — ${w.availableBeds} free${w.genderPolicy !== 'any' ? ` (${w.genderPolicy})` : ''}` }))} />
            <DoctorSelect label="Attending doctor" required value={doctorId} onChange={setDoctorId} error={err?.fields?.attendingDoctorId} />
          </div>
          {selectedWard && selectedWard.availableBeds === 0 && <Callout tone="caution" title="No beds are currently available in this ward.">Choose another ward.</Callout>}
          <div><p className="mb-2 text-sm font-semibold">Bed</p><BedChooser wardId={wardId} value={bedId} onChange={setBedId} gender={patient?.gender} /></div>
          <Textarea label="Reason for admission" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} error={err?.fields?.reason} />
          {err && !Object.keys(err.fields ?? {}).length && (
            <Callout tone="caution" title={err.message}>
              {err.details?.suggestions?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">{err.details.suggestions.map((s) => <Button key={s.wardId} size="sm" variant="secondary" onClick={() => { setWardId(String(s.wardId)); setBedId(null); setErr(null); }}>{s.wardName} ({s.availableBeds} free)</Button>)}</div>
              )}
            </Callout>
          )}
          {err?.fields?.wardId && err.details?.suggestions && <div className="flex flex-wrap gap-2">{err.details.suggestions.slice(0, 4).map((s) => <Button key={s.wardId} size="sm" variant="secondary" onClick={() => { setWardId(String(s.wardId)); setBedId(null); setErr(null); }}>{s.wardName}</Button>)}</div>}
          <div className="flex justify-end"><Button type="submit" size="lg" icon={BedDouble} disabled={!patient || !wardId || !bedId || !doctorId || !reason.trim()} loading={admit.isPending}>Admit and assign bed</Button></div>
        </form>
      </Panel>
    </div>
  );
}

// ----------------------------------------------------------------- admission detail
export function AdmissionDetailPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const q = useApi(`/admissions/${id}`);
  const { can, user } = useAuth();
  const [transferOpen, setTransferOpen] = useState(Boolean(params.get('transfer')));
  const [dischargeOpen, setDischargeOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const approve = useAction(() => post(`/admissions/${id}/approve-discharge`, { notes: '' }), { success: 'Discharge approved', invalidate: ['admissions', 'wards'] });
  return (
    <QueryState query={q}>
      {(a) => (
        <div>
          <PageHeader way="wards" back={<BackLink to={can('admissions.manage') ? '/admissions' : '/wards/board'}>{can('admissions.manage') ? 'Admissions' : 'Bed board'}</BackLink>} title={`${a.patient.fullName}`} subtitle={`${a.admissionCode}, ${a.ward.name} bed ${a.bed.bedNumber}`}
            actions={<>
              <Status value={a.status === 'active' ? 'in_patient' : 'discharged'} />
              {a.status === 'active' && can('admissions.manage') && <Button variant="secondary" icon={ArrowRightLeft} onClick={() => setTransferOpen(true)}>Transfer</Button>}
              {a.status === 'active' && user.role === 'doctor' && !a.dischargeApprovedAt && <Button variant="secondary" onClick={() => approve.mutate()} loading={approve.isPending}>Approve discharge</Button>}
              {a.status === 'active' && (can('admissions.manage') || user.role === 'doctor') && <Button icon={LogOut} onClick={() => setDischargeOpen(true)}>Discharge</Button>}
              {a.dischargeSummary && <Button variant="secondary" icon={Printer} onClick={() => setSummaryOpen(true)}>Discharge summary</Button>}
            </>} />
          {a.status === 'active' && (a.dischargeApprovedAt
            ? <Callout tone="ok" className="mb-4" title={`Discharge approved by ${a.dischargeApprovedByName}`}>{dateTime(a.dischargeApprovedAt)}{a.dischargeNotes ? `. ${a.dischargeNotes}` : ''}</Callout>
            : <Callout tone="info" className="mb-4">Waiting for the doctor to confirm the patient is ready for discharge.</Callout>)}
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel title="Admission">
              <KeyValue items={[['Patient', <Link key="p" className="link" to={`/patients/${a.patient.id}`}>{a.patient.fullName} ({a.patient.patientCode})</Link>], ['Age / sex', `${a.patient.age} y, ${a.patient.gender}`], ['Attending doctor', a.doctor.fullName], ['Reason', a.reason], ['Admitted', `${dateTime(a.admittedAt)} by ${a.admittedByName}`], ['Current bed', `${a.ward.name}, ${a.bed.bedNumber}`], a.dischargedAt && ['Discharged', `${dateTime(a.dischargedAt)} by ${a.dischargedByName}`]]} />
            </Panel>
            <Panel title="Transfer history" bodyClass="">
              <Table rows={a.transfers} empty={<p className="px-4 py-4 text-sm text-muted">No transfers.</p>} columns={[
                { header: 'When', render: (t) => dateTime(t.at) }, { header: 'From', key: 'from' }, { header: 'To', key: 'to' }, { header: 'Reason', key: 'reason' }, { header: 'By', key: 'byName' },
              ]} />
            </Panel>
          </div>
          {transferOpen && <TransferModal a={a} requestId={params.get('transfer')} onClose={() => setTransferOpen(false)} />}
          {dischargeOpen && <DischargeModal a={a} onClose={() => setDischargeOpen(false)} onDone={() => { setDischargeOpen(false); setSummaryOpen(true); }} />}
          {summaryOpen && a.dischargeSummary && <DischargeSummaryModal s={a.dischargeSummary} onClose={() => setSummaryOpen(false)} />}
        </div>
      )}
    </QueryState>
  );
}

function TransferModal({ a, requestId, onClose }) {
  const wards = useApi('/wards');
  const [wardId, setWardId] = useState('');
  const [bedId, setBedId] = useState(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(null);
  const move = useAction(() => post(`/admissions/${a.id}/transfer`, { toWardId: Number(wardId), toBedId: bedId, reason, requestId: requestId ? Number(requestId) : undefined }), { quietErrors: true, success: 'Patient transferred', invalidate: ['admissions', 'wards'], onError: (e) => { setErr(e); return true; }, onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title={`Transfer ${a.patient.fullName}`} width="max-w-2xl" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!wardId || !bedId || !reason.trim()} loading={move.isPending} onClick={() => move.mutate()}>Transfer patient</Button></>}>
      <p className="mb-4 text-sm">Currently in <strong>{a.ward.name}, bed {a.bed.bedNumber}</strong>. The old bed is freed and the new bed occupied at the same moment; the move is logged with the reason.</p>
      <div className="space-y-4">
        <Select label="Destination ward" required placeholder="Choose a ward" value={wardId} onChange={(e) => { setWardId(e.target.value); setBedId(null); setErr(null); }} options={(wards.data?.data ?? []).map((w) => ({ value: w.id, label: `${w.name} — ${w.availableBeds} free` }))} />
        <BedChooser wardId={wardId} value={bedId} onChange={setBedId} />
        <Textarea label="Reason for transfer" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} error={err?.fields?.reason} />
        {err && <Callout tone="caution" title={err.message}>{err.details?.suggestions?.length ? `Wards with free beds: ${err.details.suggestions.map((s) => s.wardName).join(', ')}. You can also wait for a bed to free up.` : null}</Callout>}
      </div>
    </Modal>
  );
}

function DischargeModal({ a, onClose, onDone }) {
  const check = useApi(`/admissions/${a.id}/discharge-check`);
  const f = useForm({ finalDiagnosis: '', conditionAtDischarge: '', treatmentSummary: a.dischargeNotes ?? '', followUpInstructions: '' });
  const [err, setErr] = useState(null);
  const go = useAction((v) => post(`/admissions/${a.id}/discharge`, v), { quietErrors: true, success: 'Patient discharged; bed is now free', invalidate: ['admissions', 'wards', 'patients', 'reports'], onError: (e) => { f.fromError(e); setErr(e); return true; }, onSuccess: onDone });
  const c = check.data;
  return (
    <Modal open onClose={onClose} title={`Discharge ${a.patient.fullName}`} width="max-w-2xl" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button icon={LogOut} disabled={!c?.billsCleared} loading={go.isPending} onClick={() => go.mutate(f.values)}>Discharge patient</Button></>}>
      <QueryState query={check}>
        {(c2) => (
          <div className="mb-4 space-y-2">
            {!c2.doctorApproved && <Callout tone="caution">A doctor has not approved this discharge yet. Receptionists can discharge only after doctor approval.</Callout>}
            {c2.billsCleared ? <Callout tone="ok" title="All bills are cleared" /> : (
              <Callout tone="alert" title="Discharge is blocked: payment pending">
                {c2.outstandingAmount > 0 && <p>Outstanding balance {money(c2.outstandingAmount)} on {c2.unpaidBills} bill(s).</p>}
                {c2.unbilledServices > 0 && <p>{c2.unbilledServices} service(s) worth {money(c2.unbilledAmount)} have not been billed yet. Accounts has been notified to prepare the final bill.</p>}
              </Callout>
            )}
          </div>
        )}
      </QueryState>
      {err && !err.fields && <Callout tone="alert" className="mb-3">{err.message}</Callout>}
      <div className="grid gap-4">
        <Input label="Final diagnosis" {...f.bind('finalDiagnosis')} hint="Leave blank to use the latest recorded diagnosis." />
        <Input label="Condition at discharge" required {...f.bind('conditionAtDischarge')} />
        <Textarea label="Treatment summary" rows={3} {...f.bind('treatmentSummary')} />
        <Textarea label="Follow-up instructions" rows={2} {...f.bind('followUpInstructions')} />
      </div>
    </Modal>
  );
}

export function DischargeSummaryModal({ s, onClose }) {
  const c = s.content;
  return (
    <Modal open onClose={onClose} title="Discharge summary" width="max-w-3xl" footer={<><Button variant="secondary" icon={Printer} onClick={() => window.print()}>Print</Button><Button onClick={onClose}>Close</Button></>}>
      <DischargeSummary c={c} generatedAt={s.generatedAt} />
    </Modal>
  );
}

export function DischargeSummary({ c, generatedAt }) {
  return (
    <div className="print-sheet text-sm">
      <PrintHeader title="Discharge summary" subtitle={c.admission?.code} />
      {c.clinicalDetailsRedacted && <p className="no-print mb-3 rounded border border-rule bg-paper px-3 py-2 text-xs text-muted">Diagnoses, medications and treatment details are shown only to the patient's doctors and to the patient in the portal.</p>}
      <KeyValue cols={3} items={[['Patient', `${c.patient.name} (${c.patient.code})`], ['Date of birth', date(c.patient.dateOfBirth)], ['Gender', c.patient.gender], ['Admitted', dateTime(c.admission.admittedAt)], ['Discharged', dateTime(c.admission.dischargedAt)], ['Final ward / bed', `${c.admission.finalWard}, ${c.admission.finalBed}`], ['Attending doctor', c.attendingDoctor], ['Reason for admission', c.admission.reason], ['Discharged by', c.dischargedBy]]} />
      {!c.clinicalDetailsRedacted && <><h3 className="mt-5 text-lg font-semibold">Diagnosis</h3>
      <p><strong>{c.finalDiagnosis ?? '—'}</strong></p></>}
      {c.diagnoses?.length > 0 && <ul className="mt-1 list-disc pl-5">{c.diagnoses.map((d, i) => <li key={i}>{d.condition} ({d.severity})</li>)}</ul>}
      <h3 className="mt-4 text-lg font-semibold">Condition at discharge</h3><p>{c.conditionAtDischarge}</p>
      {c.treatmentSummary && <><h3 className="mt-4 text-lg font-semibold">Treatment</h3><p className="whitespace-pre-wrap">{c.treatmentSummary}</p></>}
      {c.medications?.length > 0 && <><h3 className="mt-4 text-lg font-semibold">Medications</h3><ul className="list-disc pl-5">{c.medications.map((m) => <li key={m}>{m}</li>)}</ul></>}
      {c.investigations?.length > 0 && <><h3 className="mt-4 text-lg font-semibold">Investigations</h3><ul className="list-disc pl-5">{c.investigations.map((m) => <li key={m}>{m}</li>)}</ul></>}
      {c.transfers?.length > 0 && <><h3 className="mt-4 text-lg font-semibold">Transfers</h3><ul className="list-disc pl-5">{c.transfers.map((t, i) => <li key={i}>{dateTime(t.at)}: to {t.to} — {t.reason}</li>)}</ul></>}
      <h3 className="mt-4 text-lg font-semibold">Follow-up</h3><p>{c.followUpInstructions ?? 'No specific follow-up.'}</p>
      <p className="mt-6 text-xs text-muted">Generated {dateTime(generatedAt)}.</p>
    </div>
  );
}
