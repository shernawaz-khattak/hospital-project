// Patient access (SRS 5.4: UC-12 Register, UC-13 Update, UC-14 Verify).
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BedDouble, CalendarPlus, KeyRound, Pencil, ShieldCheck, UserPlus } from 'lucide-react';
import { del, post, patch, qs } from '../api/client.js';
import { useAction, useApi } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { BackLink } from '../components/domain.jsx';
import { Button, Callout, Checkbox, EmptyState, Input, KeyValue, Modal, PageHeader, Pagination, Panel, QueryState, Select, Status, Table, Tabs, Textarea, useConfirm, useForm } from '../components/ui.jsx';
import { useDraft } from '../lib/drafts.js';
import { date, dateTime, money, time, today, titleCase } from '../lib/format.js';

const BLOOD = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

export function PatientListPage() {
  const [f, setF] = useState({ q: '', status: '', page: 1 });
  const q = useApi(`/patients${qs({ ...f, pageSize: 20 })}`);
  const nav = useNavigate();
  const { can } = useAuth();
  return (
    <div>
      <PageHeader way="patients" title="Patients" subtitle="Search by name, phone, CNIC or patient ID." actions={can('patients.create') && <Link to="/patients/new"><Button icon={UserPlus}>Register patient</Button></Link>} />
      <Panel bodyClass="">
        <div className="flex flex-wrap gap-3 border-b border-rule p-3">
          <input className="field-input max-w-md" autoFocus placeholder="Name, phone, CNIC or patient ID" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} aria-label="Search patients" />
          <select className="field-input w-44" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })} aria-label="Status">
            <option value="">Any status</option><option value="out_patient">Out-patient</option><option value="in_patient">In-patient</option><option value="discharged">Discharged</option>
          </select>
        </div>
        <QueryState query={q}>
          {(r) => (
            <>
              <Table rows={r.data} onRowClick={(p) => nav(`/patients/${p.id}`)}
                empty={<EmptyState title={f.q ? `No patient matches “${f.q}”` : 'No patients yet'} action={can('patients.create') && <Link to="/patients/new"><Button icon={UserPlus}>Register a new patient</Button></Link>}>Check the spelling or the ID, or register the patient.</EmptyState>}
                columns={[
                  { header: 'Patient ID', render: (p) => <span className="font-semibold tabular-nums">{p.patientCode}</span> },
                  { header: 'Name', render: (p) => <span className="font-semibold">{p.fullName}</span> },
                  { header: 'Age / sex', render: (p) => `${p.age} y, ${p.gender}` },
                  { header: 'Phone', key: 'phone' },
                  { header: 'Blood', key: 'bloodGroup' },
                  { header: 'Status', render: (p) => <Status value={p.status} /> },
                  { header: 'Registered', render: (p) => date(p.createdAt) },
                ]} />
              <Pagination page={r.page} pageSize={r.pageSize} total={r.total} onChange={(page) => setF({ ...f, page })} />
            </>
          )}
        </QueryState>
      </Panel>
    </div>
  );
}

const EMPTY = { firstName: '', lastName: '', dateOfBirth: '', gender: '', bloodGroup: '', maritalStatus: '', phone: '', email: '', nationalId: '', address: '', city: '', emergencyContactName: '', emergencyContactPhone: '', emergencyContactRelation: '', allergies: '', medicalHistory: '', currentMedications: '', createPortalAccount: false };

function PatientFields({ f }) {
  return (
    <>
      <fieldset className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="mb-2 font-sign text-lg font-semibold">Personal details</legend>
        <Input label="First name" required {...f.bind('firstName')} />
        <Input label="Last name" required {...f.bind('lastName')} />
        <Input label="Date of birth" type="date" max={today()} required {...f.bind('dateOfBirth')} />
        <Select label="Gender" required placeholder="Choose" options={[{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }]} {...f.bind('gender')} />
        <Input label="CNIC / national ID" placeholder="61101-1234567-1" hint="Used to prevent duplicate records" {...f.bind('nationalId')} />
        <Input label="Phone" required placeholder="0300-1234567" {...f.bind('phone')} />
        <Input label="Email" type="email" {...f.bind('email')} />
        <Select label="Marital status" placeholder="Not stated" options={['Single', 'Married', 'Widowed', 'Divorced']} {...f.bind('maritalStatus')} />
        <Input label="Address" className="sm:col-span-2 lg:col-span-3" {...f.bind('address')} />
        <Input label="City" {...f.bind('city')} />
      </fieldset>
      <fieldset className="mt-6 grid gap-4 sm:grid-cols-3">
        <legend className="mb-2 font-sign text-lg font-semibold">Emergency contact</legend>
        <Input label="Contact name" {...f.bind('emergencyContactName')} />
        <Input label="Contact phone" {...f.bind('emergencyContactPhone')} />
        <Input label="Relationship to patient" {...f.bind('emergencyContactRelation')} />
      </fieldset>
      <fieldset className="mt-6 grid gap-4 sm:grid-cols-3">
        <legend className="mb-2 font-sign text-lg font-semibold">Medical details</legend>
        <Select label="Blood group" placeholder="Unknown" options={BLOOD} {...f.bind('bloodGroup')} />
        <Textarea label="Allergies" rows={2} placeholder="e.g. Penicillin" {...f.bind('allergies')} />
        <Textarea label="Current medications" rows={2} {...f.bind('currentMedications')} />
        <Textarea label="Medical history" rows={3} className="sm:col-span-3" placeholder="Chronic conditions, surgeries, relevant family history" {...f.bind('medicalHistory')} />
      </fieldset>
    </>
  );
}

export function PatientRegisterPage() {
  const nav = useNavigate();
  const f = useForm(EMPTY);
  const draft = useDraft('patient-register', f.values, { isEmpty: (v) => !v.firstName && !v.lastName && !v.phone });
  const [dupes, setDupes] = useState(null);
  const [reason, setReason] = useState('');
  const [created, setCreated] = useState(null);
  const save = useAction((body) => post('/patients', body), {
    quietErrors: true,
    onError: (err) => {
      f.fromError(err);
      if (err.code === 'POSSIBLE_DUPLICATE' || err.code === 'DUPLICATE_PATIENT') setDupes({ matches: err.details.matches, blocking: err.code === 'DUPLICATE_PATIENT', message: err.message });
      return true;
    },
    onSuccess: (r) => { draft.clear(); setDupes(null); setCreated(r); },
    invalidate: ['patients', 'reports'],
  });
  const submit = (e, confirmDuplicate) => {
    e?.preventDefault();
    save.mutate({ ...f.values, ...(confirmDuplicate ? { confirmDuplicate: true, duplicateReason: reason } : {}) });
  };
  return (
    <div>
      <PageHeader way="patients" title="Register patient" subtitle="A unique patient ID is assigned when the record is saved." back={<BackLink to="/patients">Patients</BackLink>} />
      {draft.draft && (
        <Callout tone="info" className="mb-4" title="You have an unsaved registration" action={<div className="flex gap-2"><Button size="sm" onClick={() => { f.setValues({ ...EMPTY, ...draft.draft.data }); draft.dismiss(); }}>Restore it</Button><Button size="sm" variant="secondary" onClick={draft.discard}>Discard</Button></div>}>
          Saved automatically {dateTime(draft.draft.updatedAt)}.
        </Callout>
      )}
      {save.error && !save.error.fields && !dupes && <Callout tone="alert" className="mb-4">{save.error.message}</Callout>}
      {save.error?.fields && Object.keys(save.error.fields).length > 0 && <Callout tone="alert" className="mb-4">Please correct the highlighted fields.</Callout>}
      <form onSubmit={submit} noValidate>
        <Panel>
          <PatientFields f={f} />
          <div className="mt-6 border-t border-rule pt-4">
            <Checkbox label="Create a patient portal account" hint="The patient can view their appointments, lab reports and bills online. Requires an email address." {...f.bind('createPortalAccount', { type: 'checkbox' })} />
          </div>
        </Panel>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => nav('/patients')}>Cancel</Button>
          <Button type="submit" icon={UserPlus} loading={save.isPending}>Register patient</Button>
        </div>
      </form>

      <Modal open={Boolean(dupes)} onClose={() => setDupes(null)} title={dupes?.blocking ? 'Patient already registered' : 'Possible duplicate'} width="max-w-2xl"
        footer={dupes?.blocking ? <Button onClick={() => setDupes(null)}>Back to the form</Button> : <><Button variant="secondary" onClick={() => setDupes(null)}>Back to the form</Button><Button disabled={reason.trim().length < 5} loading={save.isPending} onClick={() => submit(null, true)}>Register as a different person</Button></>}>
        <p className="text-sm">{dupes?.message}</p>
        <ul className="mt-3 divide-y divide-rule rounded border border-rule">
          {dupes?.matches.map((m) => (
            <li key={m.patient.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span><strong>{m.patient.fullName}</strong> {m.patient.patientCode}<span className="block text-xs text-muted">Born {date(m.patient.dateOfBirth)}, {m.patient.phone}. Match on {m.reason === 'national_id' ? 'national ID' : m.reason === 'name_dob' ? 'name and date of birth' : 'phone and date of birth'}.</span></span>
              <Link to={`/patients/${m.patient.id}`} className="link whitespace-nowrap" onClick={() => draft.clear()}>Open record</Link>
            </li>
          ))}
        </ul>
        {!dupes?.blocking && <Textarea className="mt-4" label="Why is this a different person?" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} hint="Recorded in the audit log." />}
      </Modal>

      <Modal open={Boolean(created)} onClose={() => nav(`/patients/${created.patient.id}`)} title="Patient registered" width="max-w-md"
        footer={<><Button variant="secondary" onClick={() => nav(`/appointments/book?patientId=${created.patient.id}`)} icon={CalendarPlus}>Book appointment</Button><Button onClick={() => nav(`/patients/${created.patient.id}`)}>Open record</Button></>}>
        {created && (
          <>
            <p className="text-sm">{created.patient.fullName} has been registered.</p>
            <p className="mt-3 rounded border border-rule bg-paper py-3 text-center"><span className="block text-xs text-muted">Patient ID</span><span className="font-sign text-3xl font-bold tracking-wide">{created.patient.patientCode}</span></p>
            {created.portal && <Callout tone="info" className="mt-3" title="Portal account created">Username: <strong>{created.portal.username}</strong>. Temporary password: <strong className="font-mono">{created.portal.tempPassword}</strong> (shown once; the patient must change it at first sign-in).</Callout>}
          </>
        )}
      </Modal>
    </div>
  );
}

export function PatientDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const q = useApi(`/patients/${id}`);
  const ov = useApi(`/patients/${id}/overview`);
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  return (
    <QueryState query={q}>
      {(p) => (
        <div>
          <PageHeader way="patients" back={<BackLink to="/patients">Patients</BackLink>}
            title={<>{p.fullName} <span className="font-sans text-lg font-normal text-muted">{p.patientCode}</span></>}
            subtitle={`${p.age} years, ${p.gender}${p.bloodGroup ? `, blood group ${p.bloodGroup}` : ''}`}
            actions={<>
              <Status value={p.status} />
              {can('appointments.manage') && <Link to={`/appointments/book?patientId=${p.id}`}><Button variant="secondary" icon={CalendarPlus}>Book appointment</Button></Link>}
              {can('admissions.manage') && p.status !== 'in_patient' && <Link to={`/admissions/new?patientId=${p.id}`}><Button variant="secondary" icon={BedDouble}>Admit</Button></Link>}
              {can('patients.update') && <Button icon={Pencil} onClick={() => setEditing(true)}>Edit</Button>}
            </>} />
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'overview', label: 'Overview' }, ...(can('patients.update') ? [{ value: 'insurance', label: 'Insurance' }, { value: 'portal', label: 'Portal access' }, { value: 'history', label: 'Change history' }] : [])]} />
          {tab === 'overview' && <PatientOverview p={p} ov={ov} />}
          {tab === 'insurance' && <InsuranceTab patientId={p.id} />}
          {tab === 'portal' && <PortalTab p={p} />}
          {tab === 'history' && <ChangeHistory patientId={p.id} />}
          {editing && <EditPatient p={p} onClose={() => setEditing(false)} />}
        </div>
      )}
    </QueryState>
  );
}

function PatientOverview({ p, ov }) {
  return (
    <div className="grid gap-5 xl:grid-cols-[1.2fr_1fr]">
      <div className="space-y-5">
        <Panel title="Personal details">
          <KeyValue cols={3} items={[
            ['Date of birth', date(p.dateOfBirth)], ['Phone', p.phone], ['Email', p.email], ['CNIC', p.nationalId ?? p.nationalIdMasked], ['Marital status', p.maritalStatus], ['City', p.city],
            p.address !== undefined && ['Address', p.address],
            ['Emergency contact', p.emergencyContactName ? `${p.emergencyContactName} (${p.emergencyContactRelation ?? 'contact'}), ${p.emergencyContactPhone ?? ''}` : null],
          ]} />
        </Panel>
        {p.allergies !== undefined && (
          <Panel title="Medical details">
            <KeyValue items={[['Allergies', p.allergies ? <span className="font-semibold text-alert">{p.allergies}</span> : 'None recorded'], ['Current medications', p.currentMedications], ['Medical history', p.medicalHistory]]} />
          </Panel>
        )}
      </div>
      <div className="space-y-5">
        <QueryState query={ov}>
          {(o) => (
            <>
              {o.activeAdmission && (
                <Callout tone="info" title={`Admitted to ${o.activeAdmission.wardName}, bed ${o.activeAdmission.bedNumber}`} action={<Link to={`/admissions/${o.activeAdmission.id}`}><Button size="sm" variant="secondary">Open</Button></Link>}>
                  Since {dateTime(o.activeAdmission.admittedAt)}{o.activeAdmission.dischargeApproved ? '. Discharge approved by the doctor.' : '.'}
                </Callout>
              )}
              {o.outstandingBalance > 0 && <Callout tone="caution" title={`Outstanding balance ${money(o.outstandingBalance)}`}>Bills must be cleared before discharge.</Callout>}
              <Panel title="Recent appointments" bodyClass="">
                <Table rows={o.appointments} empty={<p className="px-4 py-4 text-sm text-muted">No appointments yet.</p>} columns={[
                  { header: 'Date', render: (a) => <>{date(a.date)} <span className="text-muted">{time(a.startTime)}</span></> },
                  { header: 'Doctor', render: (a) => <>{a.doctorName}<span className="block text-xs text-muted">{a.specialization}</span></> },
                  { header: 'Token', key: 'tokenNumber' },
                  { header: 'Status', render: (a) => <Status value={a.status} /> },
                ]} />
              </Panel>
            </>
          )}
        </QueryState>
      </div>
    </div>
  );
}

function EditPatient({ p, onClose }) {
  const f = useForm(Object.fromEntries(Object.keys(EMPTY).filter((k) => k !== 'createPortalAccount').map((k) => [k, p[k] ?? ''])));
  const save = useAction((v) => patch(`/patients/${p.id}`, v), { success: 'Patient details updated', invalidate: ['patients'], onError: (e) => { f.fromError(e); return Boolean(e.fields); }, onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title={`Edit ${p.fullName}`} width="max-w-5xl" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="edit-patient" loading={save.isPending}>Save changes</Button></>}>
      <form id="edit-patient" onSubmit={(e) => { e.preventDefault(); save.mutate(f.values); }} noValidate>
        <p className="mb-4 text-sm text-muted">Every change is recorded with the date, time and your name.</p>
        <PatientFields f={f} />
      </form>
    </Modal>
  );
}

function InsuranceTab({ patientId }) {
  const q = useApi(`/patients/${patientId}/insurance`);
  const providers = useApi('/billing/insurance-providers');
  const f = useForm({ providerId: '', policyNumber: '', coveragePercent: '', validFrom: today(), validUntil: '' });
  const save = useAction((v) => post(`/patients/${patientId}/insurance`, v), { success: 'Insurance policy saved', invalidate: ['patients'], onError: (e) => { f.fromError(e); return Boolean(e.fields); }, onSuccess: () => f.reset() });
  return (
    <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
      <Panel title="Policies" bodyClass="">
        <QueryState query={q}>
          {(r) => <Table rows={r.data} empty={<EmptyState icon={ShieldCheck} title="No insurance on file" />} columns={[
            { header: 'Insurer', key: 'providerName' }, { header: 'Policy', key: 'policyNumberMasked' }, { header: 'Coverage', render: (i) => `${i.coveragePercent}%` },
            { header: 'Valid', render: (i) => `${date(i.validFrom)} – ${date(i.validUntil)}` },
            { header: 'Status', render: (i) => (!i.isActive ? <Status value="inactive" label="Replaced" /> : i.expired ? <Status value="expired" /> : <Status value="active" />) },
          ]} />}
        </QueryState>
      </Panel>
      <Panel title="Add or replace policy">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(f.values); }} noValidate>
          <Select label="Insurer" required placeholder="Choose" options={(providers.data?.data ?? []).filter((x) => x.isActive).map((x) => ({ value: x.id, label: `${x.name} (${x.defaultCoveragePercent}%)` }))} {...f.bind('providerId')} />
          <Input label="Policy number" required {...f.bind('policyNumber')} />
          <Input label="Coverage %" type="number" min="1" max="100" hint="Leave blank to use the insurer's default" {...f.bind('coveragePercent')} />
          <div className="grid grid-cols-2 gap-3"><Input label="Valid from" type="date" required {...f.bind('validFrom')} /><Input label="Valid until" type="date" required {...f.bind('validUntil')} /></div>
          <p className="text-xs text-muted">Details are checked against the insurer's accepted format. External insurer systems are not connected (outside the SRS scope).</p>
          <Button type="submit" loading={save.isPending}>Save policy</Button>
        </form>
      </Panel>
    </div>
  );
}

function PortalTab({ p }) {
  const [email, setEmail] = useState(p.email ?? '');
  const [result, setResult] = useState(null);
  const confirm = useConfirm();
  const enable = useAction(() => post(`/patients/${p.id}/portal-access`, { email }), { invalidate: ['patients'], onSuccess: setResult });
  const disable = useAction(() => del(`/patients/${p.id}/portal-access`), { success: 'Portal access disabled', invalidate: ['patients'] });
  return (
    <Panel title="Patient portal" className="max-w-xl">
      {p.hasPortalAccount && !result ? (
        <>
          <p className="text-sm">This patient can sign in to the portal with the username <strong>{p.patientCode}</strong>.</p>
          <Button className="mt-3" variant="secondary" onClick={async () => (await confirm({ title: 'Disable portal access?', danger: true, confirmLabel: 'Disable', message: 'The patient will be signed out and can no longer use the portal until access is enabled again.' })) && disable.mutate()}>Disable portal access</Button>
        </>
      ) : result ? (
        <Callout tone="ok" title="Portal access enabled">Username <strong>{result.username}</strong>, temporary password <strong className="font-mono">{result.tempPassword}</strong>. Give it to the patient; it must be changed at first sign-in.</Callout>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); enable.mutate(); }}>
          <p className="text-sm">Give the patient access to view their own appointments, lab reports and bills.</p>
          <Input label="Email address" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={enable.error?.fields?.email} />
          <Button type="submit" icon={KeyRound} loading={enable.isPending}>Enable portal access</Button>
        </form>
      )}
    </Panel>
  );
}

function ChangeHistory({ patientId }) {
  const q = useApi(`/patients/${patientId}/changes`);
  return (
    <Panel title="Change history" subtitle="Every registration and update, with date, time and user. Sensitive values are not shown." bodyClass="">
      <QueryState query={q}>
        {(r) => <Table rows={r.data} empty={<p className="px-4 py-4 text-sm text-muted">No changes recorded.</p>} columns={[
          { header: 'When', render: (c) => dateTime(c.at) },
          { header: 'By', key: 'by' },
          { header: 'Action', render: (c) => titleCase(c.action.split('.')[1]) },
          { header: 'Details', render: (c) => (c.details?.changes ? c.details.changes.map((ch) => (ch.sensitive ? `${ch.field} (changed)` : `${ch.field}: ${ch.from ?? '—'} → ${ch.to ?? '—'}`)).join('; ') : c.details?.patientCode ?? c.details?.provider ?? '') },
        ]} />}
      </QueryState>
    </Panel>
  );
}
