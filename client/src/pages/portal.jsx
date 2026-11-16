// Patient self-service portal (SRS 5.11: UC-48 Own Info, UC-49 Own Lab Reports, UC-50 Own Bills; FR-11 booking).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarPlus, FileText, FlaskConical, Receipt } from 'lucide-react';
import { api, openFile, qs } from '../api/client.js';
import { useApi } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { Button, Callout, EmptyState, KeyValue, Modal, PageHeader, Panel, QueryState, StatStrip, Status, Table, Token, useToast } from '../components/ui.jsx';
import { date, dateTime, money, time, today, weekday } from '../lib/format.js';
import { AppointmentModal, BookedConfirmation, BookingForm } from './appointments.jsx';
import { BillItems, ReceiptModal } from './billing.jsx';
import { ResultTable } from './lab.jsx';
import { DischargeSummary } from './wards.jsx';

export function PortalHomePage() {
  const q = useApi('/portal/me');
  const appts = useApi(`/appointments${qs({ from: today(), status: 'scheduled,cancellation_requested', pageSize: 5 })}`);
  return (
    <QueryState query={q}>
      {(m) => {
        const p = m.profile;
        return (
          <div>
            <PageHeader way="portal" title={`Hello, ${p.firstName}`} subtitle={`Patient ID ${p.patientCode}`} actions={<Link to="/portal/appointments?book=1"><Button icon={CalendarPlus}>Book appointment</Button></Link>} />
            {m.activeAdmission && <Callout tone="info" className="mb-4" title={`You are admitted to ${m.activeAdmission.ward}, bed ${m.activeAdmission.bed}`}>Since {dateTime(m.activeAdmission.admittedAt)}.</Callout>}
            <StatStrip items={[
              { label: 'Upcoming appointments', value: m.summary.upcoming },
              { label: 'Lab reports available', value: m.summary.reports },
              { label: 'Tests in progress', value: m.summary.pending_labs },
              { label: 'Balance to pay', value: money(m.summary.balance), tone: m.summary.balance > 0 ? 'caution' : undefined },
            ]} />
            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              <Panel title="Next appointments" bodyClass="" actions={<Link className="link text-sm" to="/portal/appointments">All appointments</Link>}>
                <QueryState query={appts}>
                  {(r) => (r.data.length === 0 ? <EmptyState title="No upcoming appointments" action={<Link to="/portal/appointments?book=1"><Button size="sm">Book one</Button></Link>} /> : (
                    <ul>{r.data.map((a) => (
                      <li key={a.id} className="flex items-center gap-3 border-b border-rule/70 px-4 py-3 last:border-0">
                        <Token n={a.tokenNumber} />
                        <div><p className="font-semibold">{weekday(a.date)} {date(a.date)}, {time(a.startTime)}</p><p className="text-sm text-muted">{a.doctor.fullName}, {a.doctor.specialization}</p></div>
                      </li>
                    ))}</ul>
                  ))}
                </QueryState>
              </Panel>
              <Panel title="My details" subtitle="To correct your details, please contact reception.">
                <KeyValue items={[['Date of birth', date(p.dateOfBirth)], ['Gender', p.gender], ['Blood group', p.bloodGroup], ['Phone', p.phone], ['Email', p.email], ['Address', p.address], ['Allergies', p.allergies ?? 'None recorded'], ['Emergency contact', p.emergencyContactName && `${p.emergencyContactName}, ${p.emergencyContactPhone ?? ''}`]]} />
                {m.insurance.filter((i) => i.isActive).map((i) => <p key={i.id} className="mt-3 text-sm">Insurance: <strong>{i.providerName}</strong> {i.policyNumberMasked}, valid until {date(i.validUntil)}{i.expired && <Status className="ml-2" value="expired" />}</p>)}
              </Panel>
            </div>
          </div>
        );
      }}
    </QueryState>
  );
}

export function PortalAppointmentsPage() {
  const { user } = useAuth();
  const me = useApi('/portal/me');
  const [booking, setBooking] = useState(new URLSearchParams(window.location.search).get('book') === '1');
  const [booked, setBooked] = useState(null);
  const q = useApi(`/appointments${qs({ pageSize: 100 })}`);
  const [active, setActive] = useState(null);
  const patient = me.data && { id: user.patientId, fullName: me.data.profile.fullName, patientCode: me.data.profile.patientCode };
  return (
    <div>
      <PageHeader way="appointments" title="My appointments" actions={!booking && <Button icon={CalendarPlus} onClick={() => setBooking(true)}>Book appointment</Button>} />
      {booking && patient && (
        <div className="mb-5">
          {booked ? <BookedConfirmation a={booked} anotherLabel="Book another" onAnother={() => setBooked(null)} onDone={() => { setBooked(null); setBooking(false); }} />
            : <Panel title="Book an appointment" actions={<Button size="sm" variant="ghost" onClick={() => setBooking(false)}>Close</Button>}><BookingForm fixedPatient={patient} onBooked={setBooked} channel="portal" /></Panel>}
        </div>
      )}
      <Panel bodyClass="">
        <QueryState query={q}>
          {(r) => <Table rows={r.data.filter((a) => a.status !== 'rescheduled')} onRowClick={setActive} empty={<EmptyState title="You have no appointments yet" />} columns={[
            { header: 'Token', render: (a) => <Token n={a.tokenNumber} muted={a.status !== 'scheduled'} />, width: 70 },
            { header: 'When', render: (a) => <span className="font-semibold">{weekday(a.date)} {date(a.date)}, {time(a.startTime)}</span> },
            { header: 'Doctor', render: (a) => <>{a.doctor.fullName}<span className="block text-xs text-muted">{a.doctor.specialization}</span></> },
            { header: 'Reason', key: 'reason' },
            { header: 'Status', render: (a) => <Status value={a.status} /> },
          ]} />}
        </QueryState>
      </Panel>
      <p className="mt-2 text-xs text-muted">Select an appointment to cancel or reschedule it. Cancellations within 1 hour of the appointment need approval from the hospital.</p>
      {active && <AppointmentModal a={active} onClose={() => setActive(null)} />}
    </div>
  );
}

export function PortalLabReportsPage() {
  const q = useApi('/portal/lab-reports');
  const toast = useToast();
  const [open, setOpen] = useState(null);
  return (
    <div>
      <PageHeader way="lab" title="My lab reports" subtitle="You are notified as soon as a new report is uploaded." />
      <Panel bodyClass="">
        <QueryState query={q}>
          {(r) => <Table rows={r.data} empty={<EmptyState icon={FlaskConical} title="No lab reports available" />} columns={[
            { header: 'Test', render: (l) => <><p className="font-semibold">{l.testName}</p><p className="text-xs text-muted">{l.requestCode}, requested by {l.doctorName}</p></> },
            { header: 'Requested', render: (l) => date(l.requestedAt) },
            { header: 'Report', render: (l) => (l.available ? <Status value="reported" label={`Available ${date(l.report.uploadedAt)}`} /> : <Status value="pending" label="Not yet available" />) },
            { header: '', className: 'text-right', render: (l) => l.available && <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" onClick={() => setOpen(l)}>Results</Button><Button size="sm" variant="secondary" icon={FileText} onClick={() => openFile(`/lab/reports/${l.report.id}/file`).catch((e) => toast({ tone: 'alert', title: e.message }))}>Open report</Button></div> },
          ]} />}
        </QueryState>
      </Panel>
      <Modal open={Boolean(open)} onClose={() => setOpen(null)} title={open?.testName} footer={<Button onClick={() => setOpen(null)}>Close</Button>}>
        {open && <><ResultTable values={open.report.resultValues} />{open.report.remarks && <p className="mt-3 text-sm">{open.report.remarks}</p>}<p className="mt-3 text-xs text-muted">Please discuss your results with your doctor.</p></>}
      </Modal>
    </div>
  );
}

export function PortalBillsPage() {
  const q = useApi('/portal/bills');
  const [bill, setBill] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const open = async (b) => setBill(await api(`/portal/bills/${b.id}`));
  return (
    <div>
      <PageHeader way="billing" title="Bills & payments" subtitle="Your billing history. Payments are made at the hospital's accounts desk." />
      <Panel bodyClass="">
        <QueryState query={q}>
          {(r) => <Table rows={r.data} onRowClick={open} empty={<EmptyState icon={Receipt} title="No billing records found" />} columns={[
            { header: 'Bill', render: (b) => <span className="whitespace-nowrap font-semibold">{b.billNumber}</span> },
            { header: 'Date', render: (b) => date(b.generatedAt) },
            { header: 'Total', render: (b) => money(b.subtotal) },
            { header: 'Insurance', render: (b) => (b.insuranceAmount ? money(b.insuranceAmount) : '—') },
            { header: 'Paid', render: (b) => money(b.amountPaid) },
            { header: 'Balance', render: (b) => <span className={b.balance > 0 ? 'font-semibold text-alert' : ''}>{money(b.balance)}</span> },
            { header: 'Status', render: (b) => <Status value={b.status} /> },
          ]} />}
        </QueryState>
      </Panel>
      <Modal open={Boolean(bill)} onClose={() => setBill(null)} title={`Bill ${bill?.billNumber ?? ''}`} width="max-w-3xl" footer={<Button onClick={() => setBill(null)}>Close</Button>}>
        {bill && (
          <>
            <BillItems b={bill} />
            {bill.payments.length > 0 && (
              <div className="mt-4">
                <p className="font-sign text-lg font-semibold">Payments</p>
                <ul className="mt-1 divide-y divide-rule text-sm">{bill.payments.map((p) => <li key={p.id} className="flex items-center justify-between py-2"><span>{dateTime(p.receivedAt)}, {money(p.amount)}</span>{p.receiptId && <Button size="sm" variant="ghost" onClick={() => api(`/billing/receipts/${p.receiptId}`).then(setReceipt)}>Receipt {p.receiptNumber}</Button>}</li>)}</ul>
              </div>
            )}
          </>
        )}
      </Modal>
      {receipt && <ReceiptModal r={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}

export function PortalRecordsPage() {
  const q = useApi('/portal/medical');
  const [summary, setSummary] = useState(null);
  return (
    <div>
      <PageHeader way="clinical" title="My health record" subtitle="Your visits, diagnoses and prescriptions. This record is read-only." />
      <QueryState query={q}>
        {(r) => (
          <div className="space-y-5">
            {r.dischargeSummaries.length > 0 && (
              <Panel title="Discharge summaries" bodyClass="">
                <ul>{r.dischargeSummaries.map((s) => <li key={s.id} className="flex items-center justify-between border-b border-rule/70 px-4 py-2.5 text-sm last:border-0"><span>{s.content.admission.finalWard}, discharged {date(s.content.admission.dischargedAt)}</span><Button size="sm" variant="ghost" onClick={() => setSummary(s)}>View</Button></li>)}</ul>
              </Panel>
            )}
            {!r.hasRecords ? <Panel><EmptyState title="No records found">Your visits will appear here after your first consultation.</EmptyState></Panel> : r.visits.map((v) => (
              <Panel key={v.id} title={`${date(v.date)} — ${v.doctor}`} subtitle={`${v.specialization}${v.reason ? `, ${v.reason}` : ''}`}>
                <div className="grid gap-4 text-sm md:grid-cols-2">
                  <div><p className="text-xs font-semibold text-muted">Diagnoses</p>{v.diagnoses.length ? v.diagnoses.map((d, i) => <p key={i}>{d.condition} <Status value={d.severity} /></p>) : <p className="text-muted">None recorded</p>}</div>
                  <div><p className="text-xs font-semibold text-muted">Prescriptions</p>{v.prescriptions.length ? v.prescriptions.flatMap((p) => p.items.map((i, k) => <p key={`${p.code}${k}`}>{i.medicine}: {i.dosage}, {i.frequency}, {i.days} days{i.instructions ? `. ${i.instructions}` : ''}</p>)) : <p className="text-muted">None</p>}</div>
                </div>
              </Panel>
            ))}
          </div>
        )}
      </QueryState>
      <Modal open={Boolean(summary)} onClose={() => setSummary(null)} title="Discharge summary" width="max-w-3xl" footer={<><Button variant="secondary" onClick={() => window.print()}>Print</Button><Button onClick={() => setSummary(null)}>Close</Button></>}>
        {summary && <DischargeSummary c={summary.content} generatedAt={summary.generatedAt} />}
      </Modal>
    </div>
  );
}
