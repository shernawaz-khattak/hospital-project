// Billing (SRS 5.9: UC-39 Generate Bill, UC-40 Apply Insurance, UC-41 Record Payment, UC-42 Issue Receipt).
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BadgeDollarSign, FileText, Plus, Printer, Receipt, ShieldCheck, Trash2, Wallet } from 'lucide-react';
import { api, post, put, qs } from '../api/client.js';
import { useAction, useApi } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { BackLink, PrintHeader } from '../components/domain.jsx';
import { Button, Callout, Checkbox, EmptyState, Input, KeyValue, Modal, PageHeader, Pagination, Panel, QueryState, Select, Status, Table, Tabs, Textarea, cx, useForm } from '../components/ui.jsx';
import { date, dateTime, money, relative, titleCase } from '../lib/format.js';

const CATEGORY_LABEL = { consultation: 'Consultation fees', lab: 'Laboratory charges', medicine: 'Medicine costs', room: 'Room charges', other: 'Other charges' };
const METHODS = [['cash', 'Cash'], ['card', 'Card'], ['bank_transfer', 'Bank transfer'], ['cheque', 'Cheque'], ['mobile_wallet', 'Mobile wallet']];

export function BillingHomePage() {
  const [q, setQ] = useState('');
  const patients = useApi(`/billing/patients${qs({ q })}`);
  const awaiting = useApi('/billing/awaiting-final-bill');
  const nav = useNavigate();
  return (
    <div>
      <PageHeader way="billing" title="Billing desk" subtitle="Find a patient to review their services, generate a bill or take a payment." actions={<Link to="/billing/bills"><Button variant="secondary" icon={Receipt}>All bills</Button></Link>} />
      {awaiting.data?.data.length > 0 && (
        <Callout tone="caution" className="mb-4" title={`${awaiting.data.data.length} discharge(s) waiting for a final bill`}>
          <div className="mt-1 flex flex-wrap gap-2">{awaiting.data.data.map((a) => <Button key={a.admissionId} size="sm" variant="secondary" onClick={() => nav(`/billing/patients/${a.patient.id}`)}>{a.patient.fullName}, {a.wardName}</Button>)}</div>
        </Callout>
      )}
      <Panel bodyClass="">
        <div className="border-b border-rule p-3"><input className="field-input max-w-md" autoFocus placeholder="Patient name, ID or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search patients" /></div>
        <QueryState query={patients}>
          {(r) => <Table rows={r.data} onRowClick={(p) => nav(`/billing/patients/${p.id}`)} empty={<EmptyState title="No patients found" />} columns={[
            { header: 'Patient', render: (p) => <><p className="font-semibold">{p.fullName}</p><p className="text-xs text-muted">{p.patientCode}</p></> },
            { header: 'Status', render: (p) => <Status value={p.status} /> },
            { header: 'Bills', key: 'billCount' },
            { header: 'Outstanding', render: (p) => <span className={cx('font-semibold tabular-nums', p.balance > 0 && 'text-alert')}>{money(p.balance)}</span> },
          ]} />}
        </QueryState>
      </Panel>
    </div>
  );
}

export function PatientBillingPage() {
  const { id } = useParams();
  const preview = useApi(`/billing/patients/${id}/unbilled`);
  const bills = useApi(`/billing/bills${qs({ patientId: id, pageSize: 50 })}`);
  const nav = useNavigate();
  const [excluded, setExcluded] = useState(new Set());
  const [others, setOthers] = useState([]);
  const [notes, setNotes] = useState('');
  const [warn, setWarn] = useState(null);
  const generate = useAction((ack) => post('/billing/bills', { patientId: Number(id), excludeKeys: [...excluded], otherCharges: others.filter((o) => o.description && o.unitPrice !== ''), acknowledgeWarnings: ack, notes }), {
    quietErrors: true, success: 'Itemized bill generated', invalidate: ['billing', 'reports', 'admissions'],
    onError: (e) => { if (e.code === 'BILLING_WARNINGS') { setWarn(e.details.warnings); return true; } return false; },
    onSuccess: (b) => nav(`/billing/bills/${b.id}`),
  });
  return (
    <QueryState query={preview}>
      {(p) => {
        const chosen = p.items.filter((i) => !excluded.has(i.key));
        const otherTotal = others.reduce((s, o) => s + Number(o.quantity || 0) * Number(o.unitPrice || 0), 0);
        const total = chosen.reduce((s, i) => s + Number(i.amount), 0) + otherTotal;
        const grouped = Object.keys(CATEGORY_LABEL).map((c) => [c, p.items.filter((i) => i.category === c)]).filter(([, list]) => list.length);
        return (
          <div>
            <PageHeader way="billing" back={<BackLink to="/billing">Billing desk</BackLink>} title={`Billing — ${p.patient.fullName}`} subtitle={`${p.patient.patientCode}, ${p.patient.age} y`} actions={<Status value={p.patient.status} />} />
            <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
              <Panel title="Services not yet billed" subtitle="Untick anything that should not be on this bill.">
                {p.warnings.length > 0 && <Callout tone="caution" className="mb-4" title="Some services are not recorded yet">{p.warnings.map((w) => <p key={w}>{w}</p>)}</Callout>}
                {p.items.length === 0 && <EmptyState icon={Receipt} title="Nothing to bill">All recorded services for this patient have been billed.</EmptyState>}
                {grouped.map(([cat, list]) => (
                  <div key={cat} className="mb-4">
                    <p className="mb-1 font-sign text-lg font-semibold">{CATEGORY_LABEL[cat]}</p>
                    <ul className="divide-y divide-rule rounded border border-rule">
                      {list.map((i) => (
                        <li key={i.key} className="flex items-center gap-3 px-3 py-2 text-sm">
                          <input type="checkbox" className="h-4 w-4 accent-scrub" disabled={i.category === 'room'} title={i.category === 'room' ? 'Room charges are billed in date order and cannot be left off' : undefined} checked={!excluded.has(i.key)} onChange={(e) => { const s = new Set(excluded); e.target.checked ? s.delete(i.key) : s.add(i.key); setExcluded(s); }} aria-label={`Include ${i.description}`} />
                          <span className="min-w-0 flex-1">{i.description}<span className="block text-xs text-muted">{date(i.serviceDate)}{i.quantity !== 1 ? `, ${i.quantity} × ${money(i.unitPrice)}` : ''}</span></span>
                          <span className="font-semibold tabular-nums">{money(i.amount)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                <p className="mb-1 font-sign text-lg font-semibold">Other charges</p>
                {others.map((o, k) => (
                  <div key={k} className="mb-2 grid grid-cols-[2fr_0.6fr_1fr_auto] gap-2">
                    <input className="field-input py-1.5" placeholder="Description" value={o.description} onChange={(e) => setOthers(others.map((x, j) => (j === k ? { ...x, description: e.target.value } : x)))} aria-label="Description" />
                    <input className="field-input py-1.5" type="number" min="1" value={o.quantity} onChange={(e) => setOthers(others.map((x, j) => (j === k ? { ...x, quantity: e.target.value } : x)))} aria-label="Quantity" />
                    <input className="field-input py-1.5" type="number" min="0" placeholder="Unit price" value={o.unitPrice} onChange={(e) => setOthers(others.map((x, j) => (j === k ? { ...x, unitPrice: e.target.value } : x)))} aria-label="Unit price" />
                    <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setOthers(others.filter((_, j) => j !== k))} aria-label="Remove charge" />
                  </div>
                ))}
                <Button size="sm" variant="quiet" icon={Plus} onClick={() => setOthers([...others, { description: '', quantity: 1, unitPrice: '' }])}>Add other charge</Button>
                <Textarea className="mt-4" label="Bill notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
                {generate.error && generate.error.code !== 'BILLING_WARNINGS' && <Callout tone="alert" className="mt-3">{generate.error.message}</Callout>}
                <div className="mt-4 flex items-center justify-between border-t border-rule pt-4">
                  <p className="text-sm">Bill total <span className="ml-2 font-sign text-2xl font-semibold tabular-nums">{money(total)}</span></p>
                  <Button icon={BadgeDollarSign} disabled={chosen.length + others.length === 0} loading={generate.isPending} onClick={() => generate.mutate(false)}>Generate itemized bill</Button>
                </div>
              </Panel>
              <Panel title="Bills" bodyClass="">
                <QueryState query={bills}>
                  {(r) => <Table rows={r.data} onRowClick={(b) => nav(`/billing/bills/${b.id}`)} empty={<p className="px-4 py-4 text-sm text-muted">No bills yet.</p>} columns={[
                    { header: 'Bill', render: (b) => <><p className="whitespace-nowrap font-semibold">{b.billNumber}</p><p className="text-xs text-muted">{date(b.generatedAt)}</p></> },
                    { header: 'Payable', render: (b) => money(b.totalPayable) },
                    { header: 'Balance', render: (b) => <span className={cx('font-semibold', b.balance > 0 && 'text-alert')}>{money(b.balance)}</span> },
                    { header: '', render: (b) => <Status value={b.status} /> },
                  ]} />}
                </QueryState>
              </Panel>
            </div>
            <Modal open={Boolean(warn)} onClose={() => setWarn(null)} title="Verify before generating" footer={<><Button variant="secondary" onClick={() => setWarn(null)}>Wait</Button><Button onClick={() => { setWarn(null); generate.mutate(true); }}>Generate anyway</Button></>}>
              <Callout tone="caution" title="Some services are not recorded yet">{warn?.map((w) => <p key={w}>{w}</p>)}</Callout>
              <p className="mt-3 text-sm">Services recorded later can be billed on a separate bill.</p>
            </Modal>
          </div>
        );
      }}
    </QueryState>
  );
}

export function BillDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const q = useApi(`/billing/bills/${id}`);
  const [payOpen, setPayOpen] = useState(false);
  const [insOpen, setInsOpen] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const [printing, setPrinting] = useState(false);
  const issue = useAction((paymentId) => post(`/billing/payments/${paymentId}/receipt`), { success: 'Receipt issued and saved to the patient record', invalidate: ['billing'], onSuccess: setReceipt });
  return (
    <QueryState query={q}>
      {(b) => (
        <div>
          <PageHeader way="billing" back={<BackLink to={`/billing/patients/${b.patient.id}`}>{b.patient.fullName}</BackLink>} title={`Bill ${b.billNumber}`} subtitle={`${b.patient.fullName} (${b.patient.patientCode}), generated ${dateTime(b.generatedAt)} by ${b.generatedByName}`}
            actions={<>
              <Status value={b.status} />
              <Button variant="secondary" icon={Printer} onClick={() => setPrinting(true)}>Print bill</Button>
              {can('billing.manage') && !b.insurance && b.status !== 'paid' && <Button variant="secondary" icon={ShieldCheck} onClick={() => setInsOpen(true)}>Apply insurance</Button>}
              {can('payments.record') && b.balance > 0 && <Button icon={Wallet} onClick={() => setPayOpen(true)}>Record payment</Button>}
            </>} />
          <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
            <Panel title="Itemized charges" bodyClass=""><BillItems b={b} /></Panel>
            <div className="space-y-5">
              <Panel title="Payments" bodyClass="">
                <Table rows={b.payments} empty={<p className="px-4 py-4 text-sm text-muted">No payment recorded yet. A receipt can be issued after a payment is recorded.</p>} columns={[
                  { header: 'Date', render: (p) => dateTime(p.receivedAt) },
                  { header: 'Amount', render: (p) => <span className="font-semibold">{money(p.amount)}</span> },
                  { header: 'Method', render: (p) => <>{titleCase(p.method)}{p.referenceNo && <span className="block text-xs text-muted">{p.referenceNo}</span>}</> },
                  { header: 'Receipt', render: (p) => (p.receiptId ? <Button size="sm" variant="ghost" icon={FileText} onClick={() => api(`/billing/receipts/${p.receiptId}`).then(setReceipt)}>{p.receiptNumber}</Button> : can('payments.record') && <Button size="sm" variant="secondary" loading={issue.isPending} onClick={() => issue.mutate(p.id)}>Issue receipt</Button>) },
                ]} />
              </Panel>
              {b.insurance && <Panel title="Insurance"><KeyValue items={[['Insurer', b.insurance.insurer], ['Policy', b.insurance.policyNumberMasked], ['Coverage', `${b.insurance.coveragePercent}%`], ['Applied', dateTime(b.insurance.appliedAt)]]} /></Panel>}
            </div>
          </div>
          {payOpen && <PaymentModal b={b} onClose={() => setPayOpen(false)} onReceipt={setReceipt} />}
          {insOpen && <InsuranceModal b={b} onClose={() => setInsOpen(false)} />}
          {receipt && <ReceiptModal r={receipt} onClose={() => setReceipt(null)} />}
          {printing && <Modal open onClose={() => setPrinting(false)} title="Bill" width="max-w-3xl" footer={<><Button variant="secondary" icon={Printer} onClick={() => window.print()}>Print</Button><Button onClick={() => setPrinting(false)}>Close</Button></>}>
            <div className="print-sheet"><PrintHeader title="Itemized bill" subtitle={b.billNumber} /><KeyValue cols={3} items={[['Patient', `${b.patient.fullName} (${b.patient.patientCode})`], ['Date', dateTime(b.generatedAt)], ['Status', titleCase(b.status)]]} /><div className="mt-4"><BillItems b={b} /></div></div>
          </Modal>}
        </div>
      )}
    </QueryState>
  );
}

export function BillItems({ b }) {
  const groups = Object.keys(CATEGORY_LABEL).map((c) => [c, b.items.filter((i) => i.category === c)]).filter(([, l]) => l.length);
  return (
    <div className="text-sm">
      <table className="table-base">
        <thead><tr><th>Description</th><th className="text-right">Qty</th><th className="text-right">Unit price</th><th className="text-right">Amount</th></tr></thead>
        <tbody>
          {groups.map(([cat, list]) => [
            <tr key={cat}><td colSpan={4} className="bg-paper font-sign text-base font-semibold">{CATEGORY_LABEL[cat]}</td></tr>,
            ...list.map((i) => <tr key={i.id}><td>{i.description}</td><td className="text-right tabular-nums">{i.quantity}</td><td className="text-right tabular-nums">{money(i.unitPrice)}</td><td className="text-right font-semibold tabular-nums">{money(i.amount)}</td></tr>),
            <tr key={`${cat}-sub`}><td colSpan={3} className="text-right text-xs text-muted">{CATEGORY_LABEL[cat]} subtotal</td><td className="text-right tabular-nums">{money(b.byCategory.find((x) => x.category === cat)?.amount)}</td></tr>,
          ])}
        </tbody>
      </table>
      <dl className="ml-auto mt-3 w-full max-w-xs space-y-1 px-3 pb-3">
        <div className="flex justify-between"><dt>Total charges</dt><dd className="tabular-nums">{money(b.subtotal)}</dd></div>
        <div className="flex justify-between"><dt>Insurance coverage</dt><dd className="tabular-nums">− {money(b.insuranceAmount)}</dd></div>
        <div className="flex justify-between font-semibold"><dt>Payable</dt><dd className="tabular-nums">{money(b.totalPayable)}</dd></div>
        <div className="flex justify-between"><dt>Paid</dt><dd className="tabular-nums">{money(b.amountPaid)}</dd></div>
        <div className="flex justify-between border-t border-ink pt-1 font-sign text-xl font-semibold"><dt>Balance due</dt><dd className="tabular-nums">{money(b.balance)}</dd></div>
      </dl>
    </div>
  );
}

function PaymentModal({ b, onClose, onReceipt }) {
  const f = useForm({ amount: b.balance, method: 'cash', referenceNo: '', notes: '' });
  const [issueReceipt, setIssueReceipt] = useState(true);
  const pay = useAction(async (v) => {
    const r = await post(`/billing/bills/${b.id}/payments`, v);
    if (issueReceipt) return { ...r, receipt: await post(`/billing/payments/${r.paymentId}/receipt`) };
    return r;
  }, { success: 'Payment recorded', invalidate: ['billing', 'reports', 'admissions'], onError: (e) => { f.fromError(e); return Boolean(e.fields); }, onSuccess: (r) => { onClose(); if (r.receipt) onReceipt(r.receipt); } });
  return (
    <Modal open onClose={onClose} title="Record payment" width="max-w-md" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button icon={Wallet} loading={pay.isPending} onClick={() => pay.mutate(f.values)}>Record payment</Button></>}>
      <p className="mb-3 text-sm">Outstanding balance: <strong className="font-sign text-xl">{money(b.balance)}</strong>. Partial payments are allowed.</p>
      <div className="space-y-3">
        <Input label="Amount" type="number" min="0.01" step="0.01" max={b.balance} required {...f.bind('amount')} />
        <Select label="Method" options={METHODS.map(([v, l]) => ({ value: v, label: l }))} {...f.bind('method')} />
        {f.values.method !== 'cash' && <Input label="Reference number" required {...f.bind('referenceNo')} />}
        <Input label="Notes" {...f.bind('notes')} />
        <Checkbox label="Issue a receipt now" checked={issueReceipt} onChange={(e) => setIssueReceipt(e.target.checked)} />
      </div>
    </Modal>
  );
}

function InsuranceModal({ b, onClose }) {
  const q = useApi(`/patients/${b.patient.id}/insurance`);
  const [policyId, setPolicyId] = useState('');
  const [err, setErr] = useState(null);
  const apply = useAction(() => post(`/billing/bills/${b.id}/insurance`, { patientInsuranceId: Number(policyId) }), { quietErrors: true, success: 'Insurance applied; payable amount reduced', invalidate: ['billing'], onError: (e) => { setErr(e); return true; }, onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title="Apply insurance" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!policyId} loading={apply.isPending} onClick={() => apply.mutate()}>Verify and apply</Button></>}>
      <QueryState query={q} empty={{ when: (r) => !r.data.length, render: <EmptyState icon={ShieldCheck} title="No insurance on file">Add the patient's policy on their profile first.</EmptyState> }}>
        {(r) => (
          <div className="space-y-2">
            {r.data.filter((p) => p.isActive).map((p) => (
              <label key={p.id} className={cx('flex cursor-pointer items-center gap-3 rounded border p-3 text-sm', Number(policyId) === p.id ? 'border-scrub bg-scrub-light/50' : 'border-rule')}>
                <input type="radio" name="policy" className="accent-scrub" checked={Number(policyId) === p.id} onChange={() => { setPolicyId(String(p.id)); setErr(null); }} />
                <span className="flex-1"><strong>{p.providerName}</strong> {p.policyNumberMasked}<span className="block text-xs text-muted">{p.coveragePercent}% coverage{p.maxCoverageAmount ? `, up to ${money(p.maxCoverageAmount)}` : ''}, valid until {date(p.validUntil)}</span></span>
                {p.expired && <Status value="expired" />}
              </label>
            ))}
            <p className="text-xs text-muted">The policy is checked locally: accepted insurer, active and not expired. Claims are not sent to external insurers.</p>
          </div>
        )}
      </QueryState>
      {err && <Callout tone="alert" className="mt-3">{err.message}</Callout>}
    </Modal>
  );
}

export function ReceiptModal({ r, onClose }) {
  return (
    <Modal open onClose={onClose} title={`Receipt ${r.receiptNumber}`} width="max-w-md" footer={<><Button variant="secondary" icon={Printer} onClick={() => window.print()}>Print</Button><Button onClick={onClose}>Close</Button></>}>
      <div className="print-sheet text-sm">
        <PrintHeader title="Payment receipt" subtitle={r.receiptNumber} />
        <KeyValue cols={1} items={[['Patient', `${r.patient.name} (${r.patient.code})`], ['Bill', r.billNumber], ['Payment date', dateTime(r.paymentDate)], ['Payment', `${r.paymentNumber}, ${titleCase(r.method)}${r.referenceNo ? ` (${r.referenceNo})` : ''}`]]} />
        <dl className="mt-4 space-y-1 border-t border-rule pt-3">
          <div className="flex justify-between"><dt>Bill payable</dt><dd className="tabular-nums">{money(r.payable)}</dd></div>
          <div className="flex justify-between font-sign text-xl font-semibold"><dt>Amount paid</dt><dd className="tabular-nums">{money(r.amountPaid)}</dd></div>
          <div className="flex justify-between"><dt>Remaining balance</dt><dd className="font-semibold tabular-nums">{money(r.remainingBalance)}</dd></div>
        </dl>
        <p className="mt-4 text-xs text-muted">Issued {dateTime(r.issuedAt)} by {r.issuedByName ?? r.issuedBy}. A copy is kept on the patient record.</p>
      </div>
    </Modal>
  );
}

export function BillsListPage() {
  const [f, setF] = useState({ status: '', q: '', page: 1 });
  const q = useApi(`/billing/bills${qs({ ...f, pageSize: 30 })}`);
  const nav = useNavigate();
  return (
    <div>
      <PageHeader way="billing" title="All bills" />
      <Panel bodyClass="">
        <div className="flex flex-wrap gap-3 border-b border-rule p-3">
          <input className="field-input max-w-xs" placeholder="Bill no., patient name or ID" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} aria-label="Search bills" />
          {[['', 'All'], ['outstanding', 'Outstanding'], ['unpaid', 'Unpaid'], ['partially_paid', 'Partly paid'], ['paid', 'Paid']].map(([v, l]) => <Button key={v} size="sm" variant={f.status === v ? 'primary' : 'secondary'} onClick={() => setF({ ...f, status: v, page: 1 })}>{l}</Button>)}
        </div>
        <QueryState query={q}>
          {(r) => (
            <>
              <Table rows={r.data} onRowClick={(b) => nav(`/billing/bills/${b.id}`)} empty={<EmptyState title="No bills match" />} columns={[
                { header: 'Bill', render: (b) => <span className="whitespace-nowrap font-semibold">{b.billNumber}</span> },
                { header: 'Date', render: (b) => date(b.generatedAt) },
                { header: 'Patient', render: (b) => <>{b.patient.fullName}<span className="block text-xs text-muted">{b.patient.patientCode}</span></> },
                { header: 'Charges', render: (b) => money(b.subtotal) }, { header: 'Insurance', render: (b) => (b.insuranceAmount ? money(b.insuranceAmount) : '—') },
                { header: 'Paid', render: (b) => money(b.amountPaid) },
                { header: 'Balance', render: (b) => <span className={cx('font-semibold', b.balance > 0 && 'text-alert')}>{money(b.balance)}</span> },
                { header: 'Status', render: (b) => <Status value={b.status} /> },
              ]} />
              <Pagination page={r.page} pageSize={r.pageSize} total={r.total} onChange={(page) => setF({ ...f, page })} />
            </>
          )}
        </QueryState>
      </Panel>
    </div>
  );
}

export function InsuranceProvidersPage() {
  const q = useApi('/billing/insurance-providers');
  const [editing, setEditing] = useState(null);
  return (
    <div>
      <PageHeader way="billing" title="Insurance providers" subtitle="Insurers the hospital accepts. Policies are verified against these details." actions={<Button icon={Plus} onClick={() => setEditing({})}>Add provider</Button>} />
      <Panel bodyClass="">
        <QueryState query={q}>
          {(r) => <Table rows={r.data} columns={[
            { header: 'Provider', render: (p) => <span className="font-semibold">{p.name}</span> }, { header: 'Default coverage', render: (p) => `${p.defaultCoveragePercent}%` },
            { header: 'Maximum per bill', render: (p) => (p.maxCoverageAmount ? money(p.maxCoverageAmount) : 'No limit') }, { header: 'Policy format', render: (p) => <code className="text-xs">{p.policyNumberPattern ?? 'Any'}</code> },
            { header: 'Status', render: (p) => <Status value={p.isActive ? 'active' : 'inactive'} /> }, { header: '', render: (p) => <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>Edit</Button> },
          ]} />}
        </QueryState>
      </Panel>
      {editing && <ProviderForm p={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ProviderForm({ p, onClose }) {
  const f = useForm({ name: p.name ?? '', defaultCoveragePercent: p.defaultCoveragePercent ?? '', maxCoverageAmount: p.maxCoverageAmount ?? '', policyNumberPattern: p.policyNumberPattern ?? '', contactPhone: p.contactPhone ?? '', isActive: p.isActive ?? true });
  const save = useAction((v) => (p.id ? put(`/billing/insurance-providers/${p.id}`, v) : post('/billing/insurance-providers', v)), { success: 'Provider saved', invalidate: ['billing'], onError: (e) => { f.fromError(e); return Boolean(e.fields); }, onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title={p.id ? `Edit ${p.name}` : 'Add insurance provider'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate(f.values)}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Name" required className="sm:col-span-2" {...f.bind('name')} />
        <Input label="Default coverage %" type="number" min="1" max="100" required {...f.bind('defaultCoveragePercent')} />
        <Input label="Maximum coverage per bill" type="number" min="0" hint="Blank for no limit" {...f.bind('maxCoverageAmount')} />
        <Input label="Policy number format" hint="Regular expression, e.g. ^SL-[0-9]{6}$" {...f.bind('policyNumberPattern')} />
        <Input label="Contact phone" {...f.bind('contactPhone')} />
        <Checkbox label="Currently accepted" {...f.bind('isActive', { type: 'checkbox' })} />
      </div>
    </Modal>
  );
}

