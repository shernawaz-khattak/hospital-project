// Pharmacy (SRS 5.8: UC-34 Verify, UC-35 Issue, UC-36 Inventory, UC-37 Restock alerts, UC-38 Expiry).
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Bell, Check, Flag, PackagePlus, Pill, Plus, SlidersHorizontal } from 'lucide-react';
import { post, patch, put, qs } from '../api/client.js';
import { useAction, useApi } from '../api/hooks.js';
import { BackLink } from '../components/domain.jsx';
import { Button, Callout, EmptyState, Input, KeyValue, Modal, PageHeader, Panel, QueryState, Select, Status, Table, Tabs, Textarea, cx, useConfirm, useForm } from '../components/ui.jsx';
import { date, dateTime, money, relative, titleCase, today } from '../lib/format.js';

// ----------------------------------------------------------------- prescription queue
export function RxQueuePage() {
  const [tab, setTab] = useState('queue');
  const q = useApi(`/pharmacy/prescriptions?status=${tab}`, { refetchInterval: 60_000 });
  const nav = useNavigate();
  return (
    <div>
      <PageHeader way="pharmacy" title="Prescriptions" subtitle="Verify each prescription within 15 minutes of receiving it." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'queue', label: 'To verify or dispense' }, { value: 'flagged', label: 'Flagged' }, { value: 'dispensed', label: 'Dispensed' }, { value: 'all', label: 'All' }]} />
      <Panel bodyClass="">
        <QueryState query={q}>
          {(r) => <Table rows={r.data} onRowClick={(p) => nav(`/pharmacy/prescriptions/${p.id}`)} empty={<EmptyState icon={Pill} title="No prescriptions here" />} columns={[
            { header: 'Prescription', render: (p) => <span className="font-semibold">{p.prescriptionCode}</span> },
            { header: 'Patient', render: (p) => <><p className="font-semibold">{p.patient.fullName}</p><p className="text-xs text-muted">{p.patient.patientCode}, {p.patient.age} y</p></> },
            { header: 'Doctor', render: (p) => p.doctor.fullName },
            { header: 'Received', render: (p) => <span className={p.verificationOverdue ? 'font-semibold text-alert' : ''}>{p.status === 'pending' ? `${p.waitingMinutes} min ago` : relative(p.sentToPharmacyAt)}{p.verificationOverdue ? ' — over 15 min' : ''}</span> },
            { header: 'Status', render: (p) => <Status value={p.status} /> },
          ]} />}
        </QueryState>
      </Panel>
    </div>
  );
}

export function RxDetailPage() {
  const { id } = useParams();
  const q = useApi(`/pharmacy/prescriptions/${id}`);
  const opts = { invalidate: ['pharmacy', 'reports'] };
  const verify = useAction(() => post(`/pharmacy/prescriptions/${id}/verify`), { ...opts, success: 'Prescription verified' });
  const [flagOpen, setFlagOpen] = useState(false);
  const [reason, setReason] = useState('');
  const flag = useAction(() => post(`/pharmacy/prescriptions/${id}/flag`, { reason }), { ...opts, success: 'Flagged; the doctor has been notified', onSuccess: () => setFlagOpen(false) });
  const [qty, setQty] = useState({});
  const [shortage, setShortage] = useState(null);
  const dispense = useAction((items) => post(`/pharmacy/prescriptions/${id}/dispense`, { items }), {
    ...opts, quietErrors: true, success: (r) => (r.status === 'dispensed' ? 'Medicines issued; inventory updated' : 'Available items issued; prescription partly dispensed'),
    onError: (e) => { if (e.code === 'OUT_OF_STOCK') setShortage(e.details); return e.code === 'OUT_OF_STOCK'; },
  });
  useEffect(() => { if (q.data) setQty(Object.fromEntries(q.data.items.map((i) => [i.id, Math.min(i.remaining, i.stock)]))); }, [q.data]);
  return (
    <QueryState query={q}>
      {(p) => {
        const canDispense = ['verified', 'partially_dispensed'].includes(p.status);
        return (
          <div>
            <PageHeader way="pharmacy" back={<BackLink to="/pharmacy/prescriptions">Prescriptions</BackLink>} title={`${p.prescriptionCode} — ${p.patient.fullName}`} subtitle={`From ${p.doctor.fullName} (${p.doctor.specialization}), received ${dateTime(p.sentToPharmacyAt)}`}
              actions={<>
                <Status value={p.status} />
                {['pending', 'verified'].includes(p.status) && <Button variant="secondary" icon={Flag} onClick={() => setFlagOpen(true)}>Flag for doctor</Button>}
                {p.status === 'pending' && <Button icon={Check} loading={verify.isPending} onClick={() => verify.mutate()}>Verify</Button>}
              </>} />
            {p.verificationOverdue && <Callout tone="alert" className="mb-4" title={`Waiting ${p.waitingMinutes} minutes`}>The target is verification within 15 minutes of receipt.</Callout>}
            {p.status === 'flagged' && <Callout tone="caution" className="mb-4" title="Flagged — waiting for the doctor">{p.flagReason}</Callout>}
            <div className="grid gap-5 xl:grid-cols-[2fr_1fr]">
              <Panel title="Medicines" bodyClass="">
                <Table rows={p.items} columns={[
                  { header: 'Medicine', render: (i) => <><p className="font-semibold">{i.name} {i.strength}</p><p className="text-xs text-muted">{i.genericName}, {i.form}</p></> },
                  { header: 'Directions', render: (i) => <>{i.dosage}, {i.frequency}, {i.durationDays} days{i.instructions && <span className="block text-xs text-muted">{i.instructions}</span>}</> },
                  { header: 'Prescribed', render: (i) => i.quantity },
                  { header: 'Issued', render: (i) => i.dispensed },
                  { header: 'In stock', render: (i) => <span className={cx('font-semibold', i.inStock ? 'text-ok' : 'text-alert')}>{i.stock}</span> },
                  ...(canDispense ? [{ header: 'Issue now', render: (i) => <input type="number" min="0" max={i.remaining} disabled={i.remaining === 0} className="field-input w-20 py-1" value={qty[i.id] ?? 0} onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })} aria-label={`Quantity to issue of ${i.name}`} /> }] : []),
                ]} />
                {canDispense && (
                  <div className="flex items-center justify-between gap-3 border-t border-rule p-3">
                    <p className="text-xs text-muted">Stock is taken from the batch that expires first. Expired batches are never issued.</p>
                    <Button icon={Pill} loading={dispense.isPending} onClick={() => dispense.mutate(p.items.map((i) => ({ prescriptionItemId: i.id, quantity: Number(qty[i.id] || 0) })))}>Issue medicines</Button>
                  </div>
                )}
                {p.status === 'pending' && <p className="border-t border-rule p-3 text-sm text-muted">Verify the prescription before issuing medicines.</p>}
              </Panel>
              <div className="space-y-5">
                <Panel title="Patient">
                  <KeyValue cols={1} items={[['Name', `${p.patient.fullName} (${p.patient.patientCode})`], ['Age / sex', `${p.patient.age} y, ${p.patient.gender}`], ['Allergies', p.patient.allergies ? <span className="font-semibold text-alert">{p.patient.allergies}</span> : 'None recorded'], ['Doctor\'s notes', p.notes]]} />
                </Panel>
                <Panel title="History">
                  <ul className="space-y-1 text-sm">
                    <li>Received {dateTime(p.sentToPharmacyAt)}</li>
                    {p.verifiedAt && <li>Verified {dateTime(p.verifiedAt)} by {p.verifiedByName}</li>}
                    {p.flaggedAt && <li>Flagged {dateTime(p.flaggedAt)} by {p.flaggedByName}</li>}
                    {p.dispensings.map((d) => <li key={d.id}>Issued {dateTime(d.at)} by {d.byName}</li>)}
                    {p.stockWarningAcknowledged && <li className="text-caution">The doctor was warned about stock and chose to send it anyway.</li>}
                  </ul>
                </Panel>
              </div>
            </div>
            <Modal open={flagOpen} onClose={() => setFlagOpen(false)} title="Flag prescription" footer={<><Button variant="secondary" onClick={() => setFlagOpen(false)}>Cancel</Button><Button disabled={!reason.trim()} loading={flag.isPending} onClick={() => flag.mutate()}>Flag and notify doctor</Button></>}>
              <Textarea label="What needs checking" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. dose unclear, interaction with current medication" />
            </Modal>
            <Modal open={Boolean(shortage)} onClose={() => setShortage(null)} title="Out of stock" width="max-w-xl" footer={<Button onClick={() => setShortage(null)}>OK</Button>}>
              <Callout tone="alert" title="Contact the doctor">Nothing was issued. Lower the quantity of these items to what is available (or 0), or ask {shortage?.doctor} to prescribe an alternative.</Callout>
              <ul className="mt-3 space-y-2 text-sm">{shortage?.shortages.map((s) => <li key={s.prescriptionItemId}><strong>{s.medicine}</strong>: needed {s.requested}, available {s.available}.{s.alternatives.length > 0 && ` In stock: ${s.alternatives.map((a) => `${a.name} ${a.strength} (${a.stock})`).join(', ')}.`}</li>)}</ul>
            </Modal>
          </div>
        );
      }}
    </QueryState>
  );
}

// ----------------------------------------------------------------- inventory (UC-36)
export function InventoryPage() {
  const [f, setF] = useState({ search: '', filter: '' });
  const q = useApi(`/pharmacy/medicines${qs({ ...f, includeInactive: 'true' })}`);
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  return (
    <div>
      <PageHeader way="pharmacy" title="Medicine inventory" subtitle="Stock counts only include batches that have not expired." actions={<Button icon={Plus} onClick={() => setAdding(true)}>Add medicine</Button>} />
      <Panel bodyClass="">
        <div className="flex flex-wrap gap-3 border-b border-rule p-3">
          <input className="field-input max-w-xs" placeholder="Brand or generic name" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} aria-label="Search medicines" />
          {[['', 'All'], ['low', 'Low stock'], ['out', 'Out of stock'], ['expiring', 'Expiry issues']].map(([v, l]) => <Button key={v} size="sm" variant={f.filter === v ? 'primary' : 'secondary'} onClick={() => setF({ ...f, filter: v })}>{l}</Button>)}
        </div>
        <QueryState query={q}>
          {(r) => <Table rows={r.data} onRowClick={(m) => nav(`/pharmacy/medicines/${m.id}`)} empty={<EmptyState title="No medicines match" />} columns={[
            { header: 'Medicine', render: (m) => <><p className="font-semibold">{m.name} {m.strength}</p><p className="text-xs text-muted">{m.genericName}, {m.form}</p></> },
            { header: 'Category', key: 'category' },
            { header: 'Price / unit', render: (m) => money(m.unitPrice) },
            { header: 'In stock', render: (m) => <span className={cx('font-semibold tabular-nums', m.outOfStock ? 'text-alert' : m.lowStock ? 'text-caution' : '')}>{m.stock}</span> },
            { header: 'Restock at', key: 'reorderLevel' },
            { header: 'Next expiry', render: (m) => <span className={m.expiringSoon ? 'font-semibold text-caution' : ''}>{m.nextExpiry ? date(m.nextExpiry) : '—'}</span> },
            { header: 'Flags', render: (m) => <div className="flex flex-wrap gap-1">{m.outOfStock ? <Status value="out" tone="alert" label="Out of stock" /> : m.lowStock && <Status value="low" tone="caution" label="Low" />}{m.expiredStock > 0 && <Status value="expired" label={`${m.expiredStock} expired`} />}{!m.isActive && <Status value="inactive" />}</div> },
          ]} />}
        </QueryState>
      </Panel>
      {adding && <MedicineForm onClose={() => setAdding(false)} />}
    </div>
  );
}

const FORMS = ['tablet', 'capsule', 'syrup', 'injection', 'cream', 'drops', 'inhaler', 'other'];
function MedicineForm({ med, onClose }) {
  const f = useForm({ name: med?.name ?? '', genericName: med?.genericName ?? '', form: med?.form ?? 'tablet', strength: med?.strength ?? '', category: med?.category ?? '', unitPrice: med?.unitPrice ?? '', reorderLevel: med?.reorderLevel ?? 10, isActive: med?.isActive ?? true });
  const save = useAction((v) => (med ? patch(`/pharmacy/medicines/${med.id}`, { name: v.name, genericName: v.genericName, form: v.form, strength: v.strength, category: v.category, unitPrice: v.unitPrice, isActive: v.isActive }) : post('/pharmacy/medicines', v)), { success: 'Medicine saved', invalidate: ['pharmacy'], onError: (e) => { f.fromError(e); return Boolean(e.fields); }, onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title={med ? `Edit ${med.name}` : 'Add medicine'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate(f.values)}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Brand name" required {...f.bind('name')} /><Input label="Generic name" required {...f.bind('genericName')} />
        <Select label="Form" options={FORMS.map((x) => ({ value: x, label: titleCase(x) }))} {...f.bind('form')} /><Input label="Strength" required placeholder="500 mg" {...f.bind('strength')} />
        <Input label="Category" required {...f.bind('category')} /><Input label="Price per unit" type="number" min="0" step="0.01" required {...f.bind('unitPrice')} />
        {!med && <Input label="Restock alert level" type="number" min="0" {...f.bind('reorderLevel')} />}
      </div>
    </Modal>
  );
}

export function MedicineDetailPage() {
  const { id } = useParams();
  const q = useApi(`/pharmacy/medicines/${id}`);
  const [receiving, setReceiving] = useState(false);
  const [adjusting, setAdjusting] = useState(null);
  const [editing, setEditing] = useState(false);
  const [level, setLevel] = useState('');
  const [levelErr, setLevelErr] = useState(null);
  const setAlert = useAction(() => put(`/pharmacy/medicines/${id}/reorder-level`, { reorderLevel: level }), { success: 'Restock alert level saved', invalidate: ['pharmacy'], onError: (e) => { setLevelErr(e.fields?.reorderLevel ?? e.message); return true; } });
  return (
    <QueryState query={q}>
      {(m) => (
        <div>
          <PageHeader way="pharmacy" back={<BackLink to="/pharmacy/inventory">Inventory</BackLink>} title={`${m.name} ${m.strength}`} subtitle={`${m.genericName}, ${m.form}, ${m.category}, ${money(m.unitPrice)} per unit`}
            actions={<><Button variant="secondary" onClick={() => setEditing(true)}>Edit details</Button><Button icon={PackagePlus} onClick={() => setReceiving(true)}>Receive stock</Button></>} />
          <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
            <Panel title="Batches" bodyClass="">
              <Table rows={m.batches} empty={<p className="px-4 py-4 text-sm text-muted">No stock received yet.</p>} columns={[
                { header: 'Batch', key: 'batchNumber' }, { header: 'Quantity', render: (b) => <span className="font-semibold">{b.quantity}</span> },
                { header: 'Expiry', render: (b) => <span className={b.expiryState === 'expired' ? 'font-semibold text-alert' : b.expiryState === 'expiring' ? 'font-semibold text-caution' : ''}>{date(b.expiryDate)}</span> },
                { header: 'State', render: (b) => (b.status === 'removed' ? <Status value="removed" label="Removed" /> : b.expiryState === 'ok' ? <Status value="active" label="Valid" /> : <Status value={b.expiryState} />) },
                { header: 'Received', render: (b) => date(b.receivedAt) }, { header: 'Supplier', key: 'supplier' },
                { header: '', render: (b) => b.status === 'active' && <Button size="sm" variant="ghost" icon={SlidersHorizontal} onClick={() => setAdjusting(b)} aria-label={`Adjust batch ${b.batchNumber}`} /> },
              ]} />
            </Panel>
            <div className="space-y-5">
              <Panel title="Stock">
                <p className="font-sign text-4xl font-semibold tabular-nums">{m.stock}</p>
                <p className="text-sm text-muted">usable units{m.expiredStock ? `; ${m.expiredStock} expired units awaiting removal` : ''}</p>
                {m.lowStock && <Callout tone="caution" className="mt-3">At or below the restock level of {m.reorderLevel}.</Callout>}
              </Panel>
              <Panel title="Restock alert" subtitle="Alert pharmacists when usable stock reaches this level.">
                <div className="flex items-end gap-2">
                  <Input label="Minimum stock" type="number" min="0" value={level === '' ? m.reorderLevel : level} onChange={(e) => { setLevel(e.target.value); setLevelErr(null); }} error={levelErr} className="flex-1" />
                  <Button icon={Bell} loading={setAlert.isPending} disabled={level === ''} onClick={() => setAlert.mutate()}>Set alert</Button>
                </div>
              </Panel>
            </div>
          </div>
          <Panel className="mt-5" title="Stock movements" bodyClass="">
            <Table rows={m.transactions} empty={<p className="px-4 py-4 text-sm text-muted">No movements yet.</p>} columns={[
              { header: 'When', render: (t) => dateTime(t.at) }, { header: 'Type', render: (t) => titleCase(t.type) },
              { header: 'Change', render: (t) => <span className={cx('font-semibold tabular-nums', t.quantityChange < 0 ? 'text-alert' : 'text-ok')}>{t.quantityChange > 0 ? '+' : ''}{t.quantityChange}</span> },
              { header: 'Stock after', key: 'stockAfter' }, { header: 'Batch', key: 'batchNumber' }, { header: 'Reason', key: 'reason' }, { header: 'By', key: 'byName' },
            ]} />
          </Panel>
          {receiving && <ReceiveStock medicineId={m.id} onClose={() => setReceiving(false)} />}
          {adjusting && <AdjustBatch batch={adjusting} onClose={() => setAdjusting(null)} />}
          {editing && <MedicineForm med={m} onClose={() => setEditing(false)} />}
        </div>
      )}
    </QueryState>
  );
}

function ReceiveStock({ medicineId, onClose }) {
  const f = useForm({ batchNumber: '', quantity: '', expiryDate: '', supplier: '', costPrice: '' });
  const save = useAction((v) => post(`/pharmacy/medicines/${medicineId}/batches`, v), { success: 'Stock received', invalidate: ['pharmacy'], onError: (e) => { f.fromError(e); return Boolean(e.fields); }, onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title="Receive stock" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate(f.values)}>Add to inventory</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Batch number" required {...f.bind('batchNumber')} /><Input label="Quantity" type="number" min="1" required {...f.bind('quantity')} />
        <Input label="Expiry date" type="date" min={today()} required {...f.bind('expiryDate')} /><Input label="Supplier" {...f.bind('supplier')} />
        <Input label="Cost price per unit" type="number" min="0" step="0.01" {...f.bind('costPrice')} />
      </div>
    </Modal>
  );
}

function AdjustBatch({ batch, onClose }) {
  const f = useForm({ quantityChange: '', reason: '' });
  const save = useAction((v) => post(`/pharmacy/batches/${batch.id}/adjust`, v), { success: 'Stock adjusted', invalidate: ['pharmacy'], onError: (e) => { f.fromError(e); return Boolean(e.fields); }, onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title={`Adjust batch ${batch.batchNumber}`} width="max-w-md" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate(f.values)}>Save adjustment</Button></>}>
      <p className="mb-3 text-sm">Current quantity: <strong>{batch.quantity}</strong>. Use a negative number to reduce stock (e.g. damaged), positive to correct a count. Stock can never go below zero.</p>
      <div className="space-y-3"><Input label="Change" type="number" required {...f.bind('quantityChange')} /><Input label="Reason" required {...f.bind('reason')} /></div>
    </Modal>
  );
}

// ----------------------------------------------------------------- expiry tracker (UC-38)
export function ExpiryPage() {
  const q = useApi('/pharmacy/expiry');
  const confirm = useConfirm();
  const remove = useAction((b) => post(`/pharmacy/batches/${b.batchId}/remove-expired`, { reason: 'Expired stock disposed' }), { success: 'Expired batch removed and logged', invalidate: ['pharmacy'] });
  return (
    <div>
      <PageHeader way="pharmacy" title="Expiry tracker" subtitle="Batches that expire within 30 days are shown in amber; expired batches in red." />
      <QueryState query={q}>
        {(r) => (r.allValid ? <Panel><EmptyState icon={Check} title="All medicines are within their valid dates" /></Panel> : (
          <Panel bodyClass="">
            <Table rows={r.data} rowKey="batchId" columns={[
              { header: 'Medicine', render: (b) => <Link className="font-semibold hover:underline" to={`/pharmacy/medicines/${b.medicineId}`}>{b.medicine}</Link> },
              { header: 'Batch', key: 'batchNumber' }, { header: 'Quantity', key: 'quantity' },
              { header: 'Expiry', render: (b) => <span className={cx('rounded px-2 py-0.5 font-semibold', b.state === 'expired' ? 'bg-alert-light text-alert' : 'bg-caution-light text-caution')}>{date(b.expiryDate)}</span> },
              { header: 'Days', render: (b) => (b.daysLeft < 0 ? `${-b.daysLeft} days ago` : `${b.daysLeft} days left`) },
              { header: '', className: 'text-right', render: (b) => b.state === 'expired' && <Button size="sm" variant="danger" onClick={async () => (await confirm({ title: 'Remove expired stock?', danger: true, confirmLabel: 'Remove batch', message: `${b.quantity} units of ${b.medicine} (batch ${b.batchNumber}) will be removed from inventory. The removal is logged.` })) && remove.mutate(b)}>Remove</Button> },
            ]} />
          </Panel>
        ))}
      </QueryState>
    </div>
  );
}

export function AlertsPage() {
  const [status, setStatus] = useState('open');
  const q = useApi(`/pharmacy/alerts?status=${status}`);
  const resolve = useAction((id) => post(`/pharmacy/alerts/${id}/resolve`), { success: 'Alert resolved', invalidate: ['pharmacy'] });
  const scan = useAction(() => post('/pharmacy/expiry/scan'), { success: (r) => `${r.flagged} new expiry alert(s)`, invalidate: ['pharmacy'] });
  return (
    <div>
      <PageHeader way="pharmacy" title="Stock alerts" subtitle="Restock and expiry alerts. Restock alerts close automatically when stock is replenished." actions={<Button variant="secondary" loading={scan.isPending} onClick={() => scan.mutate()}>Check expiry now</Button>} />
      <div className="mb-3 flex gap-2">{['open', 'resolved', 'all'].map((s) => <Button key={s} size="sm" variant={status === s ? 'primary' : 'secondary'} onClick={() => setStatus(s)}>{titleCase(s)}</Button>)}</div>
      <Panel bodyClass="">
        <QueryState query={q}>
          {(r) => <Table rows={r.data} empty={<EmptyState icon={Bell} title="No alerts" />} columns={[
            { header: 'Type', render: (a) => <Status value={a.type} tone={a.type === 'low_stock' ? 'caution' : a.type === 'expired' ? 'alert' : 'caution'} label={titleCase(a.type.replace('near_', 'expiring '))} /> },
            { header: 'Medicine', render: (a) => <Link className="link" to={`/pharmacy/medicines/${a.medicineId}`}>{a.medicine}</Link> },
            { header: 'Message', key: 'message' }, { header: 'Raised', render: (a) => relative(a.createdAt) }, { header: 'Status', render: (a) => <Status value={a.status} /> },
            { header: '', render: (a) => a.status === 'open' && <Button size="sm" variant="ghost" onClick={() => resolve.mutate(a.id)}>Resolve</Button> },
          ]} />}
        </QueryState>
      </Panel>
    </div>
  );
}
