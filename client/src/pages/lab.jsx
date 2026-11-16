// Laboratory (SRS 5.7: UC-30 Process, UC-31 Upload, UC-32 View, UC-33 Notify).
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FileText, FlaskConical, Pause, Play, Plus, Trash2, Upload, CheckCircle2, Pencil } from 'lucide-react';
import { api, openFile, post, put, qs } from '../api/client.js';
import { useAction, useApi } from '../api/hooks.js';
import { BackLink } from '../components/domain.jsx';
import { Button, Callout, Checkbox, EmptyState, Input, KeyValue, Modal, PageHeader, Pagination, Panel, QueryState, Status, Table, Tabs, Textarea, cx, useForm, useToast } from '../components/ui.jsx';
import { dateTime, minutes, money, relative } from '../lib/format.js';

export function LabQueuePage() {
  const [tab, setTab] = useState('pending');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const q = useApi(`/lab/requests${qs({ status: tab, q: search, page, pageSize: 30 })}`);
  const nav = useNavigate();
  return (
    <div>
      <PageHeader way="lab" title="Lab requests" subtitle="STAT and urgent requests are listed first." />
      <Tabs value={tab} onChange={(t) => { setTab(t); setPage(1); }} tabs={[{ value: 'pending', label: 'To process' }, { value: 'ready', label: 'Ready to upload' }, { value: 'reported', label: 'Reported' }, { value: 'all', label: 'All' }]} />
      <Panel bodyClass="">
        <div className="border-b border-rule p-3"><input className="field-input max-w-sm" placeholder="Request no., patient, or test" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} aria-label="Search" /></div>
        <QueryState query={q}>
          {(r) => (
            <>
              <Table rows={r.data} onRowClick={(l) => nav(`/lab/requests/${l.id}`)} empty={<EmptyState icon={FlaskConical} title="Nothing waiting here" />} columns={[
                { header: 'Urgency', render: (l) => <Status value={l.urgency} /> },
                { header: 'Request', render: (l) => <><p className="font-semibold">{l.test.name}</p><p className="text-xs text-muted">{l.requestCode}, {l.test.sampleType}</p></> },
                { header: 'Patient', render: (l) => <><p className="font-semibold">{l.patient.fullName}</p><p className="text-xs text-muted">{l.patient.patientCode}, {l.patient.age} y, {l.patient.gender}</p></> },
                { header: 'Doctor', render: (l) => l.doctor.fullName },
                { header: 'Requested', render: (l) => <span className={l.overdue ? 'font-semibold text-alert' : ''}>{relative(l.createdAt)}{l.overdue ? ' (past turnaround)' : ''}</span> },
                { header: 'Status', render: (l) => <Status value={l.status} /> },
              ]} />
              <Pagination page={r.page} pageSize={r.pageSize} total={r.total} onChange={setPage} />
            </>
          )}
        </QueryState>
      </Panel>
    </div>
  );
}

export function LabRequestPage() {
  const { id } = useParams();
  const q = useApi(`/lab/requests/${id}`);
  const toast = useToast();
  const opts = { invalidate: ['lab', 'reports'] };
  const start = useAction(() => post(`/lab/requests/${id}/start`), { ...opts, success: 'Processing started' });
  const complete = useAction(() => post(`/lab/requests/${id}/complete`), { ...opts, success: 'Test completed; upload the report next' });
  const [delayOpen, setDelayOpen] = useState(false);
  const [reason, setReason] = useState('');
  const delay = useAction(() => post(`/lab/requests/${id}/delay`, { reason }), { ...opts, success: 'Marked as delayed; the doctor has been notified', onSuccess: () => setDelayOpen(false) });
  return (
    <QueryState query={q}>
      {(l) => (
        <div>
          <PageHeader way="lab" back={<BackLink to="/lab/requests">Lab requests</BackLink>} title={l.test.name} subtitle={`${l.requestCode}, requested ${dateTime(l.createdAt)} by ${l.doctor.fullName}`}
            actions={<>
              <Status value={l.urgency} /><Status value={l.status} />
              {['requested', 'delayed'].includes(l.status) && <Button icon={Play} loading={start.isPending} onClick={() => start.mutate()}>{l.status === 'delayed' ? 'Resume processing' : 'Start processing'}</Button>}
              {['requested', 'in_progress'].includes(l.status) && <Button variant="secondary" icon={Pause} onClick={() => setDelayOpen(true)}>Materials unavailable</Button>}
              {l.status === 'in_progress' && <Button icon={CheckCircle2} loading={complete.isPending} onClick={() => complete.mutate()}>Mark test completed</Button>}
              {l.report && <Button variant="secondary" icon={FileText} onClick={() => openFile(`/lab/reports/${l.report.id}/file`).catch((e) => toast({ tone: 'alert', title: e.message }))}>Open report</Button>}
            </>} />
          {l.status === 'delayed' && <Callout tone="caution" className="mb-4" title="Delayed">{l.delayReason}. The requesting doctor was notified {relative(l.delayedAt)}.</Callout>}
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel title="Request">
              <KeyValue items={[
                ['Patient', `${l.patient.fullName} (${l.patient.patientCode})`], ['Age / sex', `${l.patient.age} y, ${l.patient.gender}`],
                ['Sample', l.test.sampleType], ['Usual turnaround', `${l.test.turnaroundHours} h`], ['Clinical notes', l.clinicalNotes], ['Special instructions', l.specialInstructions],
                ['Parameters requested', l.parameters.join(', ')], ['Technician', l.technicianName],
                ['Started', l.startedAt && dateTime(l.startedAt)], ['Completed', l.completedAt && dateTime(l.completedAt)], ['Processing time', l.processingMinutes != null && minutes(l.processingMinutes)],
              ]} />
            </Panel>
            {l.status === 'completed' ? <UploadReport l={l} /> : l.report ? (
              <Panel title="Report" subtitle={`Uploaded ${dateTime(l.report.uploadedAt)} by ${l.report.uploadedByName}`}>
                <ResultTable values={l.report.resultValues} />
                {l.report.remarks && <p className="mt-2 text-sm">{l.report.remarks}</p>}
                <p className="mt-2 text-xs text-muted">{l.report.originalName}, {(l.report.fileSize / 1024).toFixed(0)} KB</p>
              </Panel>
            ) : <Panel title="Report"><p className="text-sm text-muted">Start and complete the test to upload its report.</p></Panel>}
          </div>
          <Modal open={delayOpen} onClose={() => setDelayOpen(false)} title="Required materials are not available" footer={<><Button variant="secondary" onClick={() => setDelayOpen(false)}>Cancel</Button><Button disabled={!reason.trim()} loading={delay.isPending} onClick={() => delay.mutate()}>Notify the doctor</Button></>}>
            <Textarea label="What is missing and when it is expected" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Modal>
        </div>
      )}
    </QueryState>
  );
}

export function ResultTable({ values }) {
  if (!values?.length) return null;
  return (
    <table className="table-base"><thead><tr><th>Parameter</th><th>Result</th><th>Reference range</th><th>Flag</th></tr></thead>
      <tbody>{values.map((v) => <tr key={v.name}><td>{v.name}</td><td className="font-semibold">{v.value} {v.unit}</td><td className="text-muted">{v.referenceRange}</td><td>{v.flag && v.flag !== 'normal' ? <Status value={v.flag} tone="alert" label={v.flag} /> : <span className="text-muted">normal</span>}</td></tr>)}</tbody></table>
  );
}

function UploadReport({ l }) {
  const params = (l.test.parameters ?? []).filter((p) => l.parameters.includes(p.name));
  const [values, setValues] = useState(params.map((p) => ({ name: p.name, value: '', unit: p.unit, referenceRange: p.referenceRange, flag: 'normal' })));
  const [file, setFile] = useState(null);
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState(null);
  const upload = useAction(() => {
    const fd = new FormData();
    if (file) fd.append('file', file);
    fd.append('resultValues', JSON.stringify(values.filter((v) => v.value.trim())));
    fd.append('remarks', remarks);
    return api(`/lab/requests/${l.id}/report`, { method: 'POST', body: fd });
  }, { quietErrors: true, success: 'Report uploaded; the doctor and patient have been notified', invalidate: ['lab', 'reports'], onError: (e) => { setError(e); return true; } });
  const tooBig = file && file.size > 10 * 1024 * 1024;
  return (
    <Panel title="Upload report" subtitle="PDF, PNG or JPEG, up to 10 MB. The file is checked for its real format.">
      <div className="space-y-2">
        {values.map((v, i) => (
          <div key={v.name} className="grid grid-cols-[1.4fr_1fr_1fr_0.9fr] items-center gap-2 text-sm">
            <span>{v.name}<span className="block text-xs text-muted">ref {v.referenceRange || '—'}</span></span>
            <input className="field-input py-1.5" value={v.value} onChange={(e) => setValues(values.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} aria-label={`${v.name} result`} />
            <span className="text-muted">{v.unit}</span>
            <select className="field-input py-1.5" value={v.flag} onChange={(e) => setValues(values.map((x, j) => (j === i ? { ...x, flag: e.target.value } : x)))} aria-label={`${v.name} flag`}><option value="normal">Normal</option><option value="low">Low</option><option value="high">High</option><option value="abnormal">Abnormal</option></select>
          </div>
        ))}
      </div>
      <Textarea className="mt-3" label="Remarks" rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
      <div className="mt-3">
        <label className="mb-1 block text-sm font-semibold">Report file<span className="text-alert">*</span></label>
        <input type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => { setFile(e.target.files[0] ?? null); setError(null); }} className="block w-full text-sm file:mr-3 file:rounded file:border file:border-rule file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-semibold" />
        {tooBig && <p className="mt-1 text-xs font-semibold text-alert">The file is larger than 10 MB.</p>}
        {error && <p className="mt-1 text-xs font-semibold text-alert">{error.fields?.file ?? error.message}</p>}
      </div>
      <div className="mt-4 flex justify-end"><Button icon={Upload} disabled={!file || tooBig} loading={upload.isPending} onClick={() => upload.mutate()}>Upload and notify</Button></div>
    </Panel>
  );
}

export function LabReportsPage() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const q = useApi(`/lab/requests${qs({ status: 'reported', q: search, page, pageSize: 30 })}`);
  const toast = useToast();
  return (
    <div>
      <PageHeader way="lab" title="Report history" />
      <Panel bodyClass="">
        <div className="border-b border-rule p-3"><input className="field-input max-w-sm" placeholder="Request no., patient, or test" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} aria-label="Search" /></div>
        <QueryState query={q}>
          {(r) => (
            <>
              <Table rows={r.data} empty={<EmptyState title="No reports found" />} columns={[
                { header: 'Reported', render: (l) => dateTime(l.report?.uploadedAt) },
                { header: 'Test', render: (l) => <><p className="font-semibold">{l.test.name}</p><p className="text-xs text-muted">{l.requestCode}</p></> },
                { header: 'Patient', render: (l) => `${l.patient.fullName} (${l.patient.patientCode})` },
                { header: 'Doctor', render: (l) => l.doctor.fullName },
                { header: 'Processing', render: (l) => minutes(l.processingMinutes) },
                { header: '', className: 'text-right', render: (l) => <div className="flex justify-end gap-1"><Link to={`/lab/requests/${l.id}`}><Button size="sm" variant="ghost">Details</Button></Link><Button size="sm" variant="secondary" icon={FileText} onClick={() => openFile(`/lab/reports/${l.report.id}/file`).catch((e) => toast({ tone: 'alert', title: e.message }))}>Open</Button></div> },
              ]} />
              <Pagination page={r.page} pageSize={r.pageSize} total={r.total} onChange={setPage} />
            </>
          )}
        </QueryState>
      </Panel>
    </div>
  );
}

export function LabTestsPage() {
  const q = useApi('/lab/tests');
  const [editing, setEditing] = useState(null);
  return (
    <div>
      <PageHeader way="lab" title="Test catalogue" subtitle="Tests doctors can request, with their standard parameters and prices." actions={<Button icon={Plus} onClick={() => setEditing({ parameters: [{ name: '', unit: '', referenceRange: '' }] })}>Add test</Button>} />
      <Panel bodyClass="">
        <QueryState query={q}>
          {(r) => <Table rows={r.data} columns={[
            { header: 'Code', key: 'code' }, { header: 'Test', render: (t) => <><p className="font-semibold">{t.name}</p><p className="text-xs text-muted">{t.parameters.map((p) => p.name).join(', ')}</p></> },
            { header: 'Category', key: 'category' }, { header: 'Sample', key: 'sampleType' }, { header: 'Price', render: (t) => money(t.price) }, { header: 'Turnaround', render: (t) => `${t.turnaroundHours} h` },
            { header: 'Status', render: (t) => <Status value={t.isAvailable ? 'available' : 'inactive'} label={t.isAvailable ? 'Available' : 'Not available'} /> },
            { header: '', render: (t) => <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`} /> },
          ]} />}
        </QueryState>
      </Panel>
      {editing && <TestForm test={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TestForm({ test, onClose }) {
  const f = useForm({ code: test.code ?? '', name: test.name ?? '', category: test.category ?? '', sampleType: test.sampleType ?? '', price: test.price ?? '', turnaroundHours: test.turnaroundHours ?? 24, isAvailable: test.isAvailable ?? true });
  const [params, setParams] = useState(test.parameters);
  const save = useAction((v) => (test.id ? put(`/lab/tests/${test.id}`, { ...v, parameters: params }) : post('/lab/tests', { ...v, parameters: params })), { success: 'Test saved', invalidate: ['lab'], onError: (e) => { f.fromError(e); return Boolean(e.fields); }, onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title={test.id ? `Edit ${test.name}` : 'Add test'} width="max-w-2xl" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate(f.values)}>Save test</Button></>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Input label="Code" required {...f.bind('code')} /><Input label="Name" required className="sm:col-span-2" {...f.bind('name')} />
        <Input label="Category" required {...f.bind('category')} /><Input label="Sample type" required {...f.bind('sampleType')} />
        <Input label="Price" type="number" min="0" required {...f.bind('price')} /><Input label="Turnaround (hours)" type="number" min="1" {...f.bind('turnaroundHours')} />
        <Checkbox className="self-end pb-2" label="Available to request" {...f.bind('isAvailable', { type: 'checkbox' })} />
      </div>
      <p className="mt-4 text-sm font-semibold">Parameters</p>
      {f.errors.parameters && <p className="text-xs font-semibold text-alert">{f.errors.parameters}</p>}
      <div className="mt-2 space-y-2">
        {params.map((p, i) => (
          <div key={i} className="grid grid-cols-[2fr_1fr_1.4fr_auto] gap-2">
            <input className="field-input py-1.5" placeholder="Name" value={p.name} onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label="Parameter name" />
            <input className="field-input py-1.5" placeholder="Unit" value={p.unit} onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))} aria-label="Unit" />
            <input className="field-input py-1.5" placeholder="Reference range" value={p.referenceRange} onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, referenceRange: e.target.value } : x)))} aria-label="Reference range" />
            <Button size="sm" variant="ghost" icon={Trash2} disabled={params.length === 1} onClick={() => setParams(params.filter((_, j) => j !== i))} aria-label="Remove parameter" />
          </div>
        ))}
      </div>
      <Button size="sm" variant="quiet" icon={Plus} className="mt-2" onClick={() => setParams([...params, { name: '', unit: '', referenceRange: '' }])}>Add parameter</Button>
    </Modal>
  );
}

