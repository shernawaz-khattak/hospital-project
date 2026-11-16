import { Link, Navigate, useNavigate } from 'react-router-dom';
import { BedDouble, CalendarPlus, ClipboardList, DatabaseBackup, FlaskConical, HeartPulse, Pill, Receipt, Stethoscope, UserPlus } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { useApi } from '../api/hooks.js';
import { Button, Callout, EmptyState, PageHeader, Panel, QueryState, StatStrip, Status, Table, Token } from '../components/ui.jsx';
import { ColumnChart } from '../components/charts.jsx';
import { bytes, date, dateTime, hospitalHour, money, moneyShort, relative, time, today } from '../lib/format.js';

const greeting = () => {
  const h = hospitalHour();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};
const shortDate = (d) => date(d).replace(/ \d{4}$/, '');

export default function Dashboard() {
  const { user } = useAuth();
  const q = useApi('/reports/dashboard', { refetchInterval: 60_000, background: true });
  if (user.role === 'patient') return <Navigate to="/portal" replace />;
  const first = user.fullName.replace(/^Dr\.\s*/, 'Dr. ').split(' ').slice(0, user.role === 'doctor' ? 2 : 1).join(' ');
  return (
    <div>
      <PageHeader title={`${greeting()}, ${first}`} subtitle={`${date(today())} — here is what needs attention today.`} />
      <QueryState query={q}>
        {(d) => {
          const View = VIEWS[d.role];
          return View ? <View d={d} /> : <EmptyState title="No dashboard for this role" />;
        }}
      </QueryState>
    </div>
  );
}

function Charts({ items }) {
  return (
    <div className="mt-5 grid gap-5 xl:grid-cols-2">
      {items.map((c) => (
        <Panel key={c.title} title={c.title} subtitle={c.subtitle}>
          <ColumnChart data={c.data} xKey="date" series={[{ key: 'value', label: c.label }]} format={c.format} xFormat={shortDate} title={c.title} />
        </Panel>
      ))}
    </div>
  );
}

function AdminDash({ d }) {
  const s = d.stats;
  return (
    <>
      <StatStrip items={[
        { label: 'Registered patients', value: s.totalPatients.toLocaleString() },
        { label: "Today's appointments", value: s.todaysAppointments },
        { label: 'Active doctors', value: s.doctors },
        { label: 'Staff', value: s.staff },
        { label: 'Departments', value: s.departments },
        { label: 'Beds free / occupied', value: `${s.availableBeds} / ${s.occupiedBeds}` },
        { label: 'Lab tests pending', value: s.pendingLabTests },
        { label: 'Low-stock medicines', value: s.lowStockMedicines, tone: s.lowStockMedicines ? 'caution' : undefined },
        { label: "Today's revenue", value: moneyShort(s.todaysRevenue) },
      ]} />
      <div className="mt-4 space-y-2">
        {s.pendingCancellationApprovals > 0 && <Callout tone="caution" title={`${s.pendingCancellationApprovals} cancellation(s) need your approval`} action={<Link to="/admin/cancellations"><Button size="sm" variant="secondary">Review</Button></Link>}>These were requested less than 1 hour before the appointment.</Callout>}
        {s.staffingShortfalls > 0 && <Callout tone="info" title={`${s.staffingShortfalls} department role(s) are below the required staffing level`} action={<Link to="/admin/staffing"><Button size="sm" variant="secondary">Open staffing</Button></Link>} />}
      </div>
      <Charts items={[
        { title: 'Appointments per day', subtitle: 'Last 14 days, all doctors', data: d.charts.appointments, label: 'Appointments' },
        { title: 'Payments received per day', subtitle: 'Last 14 days', data: d.charts.revenue, label: 'Revenue', format: (v, axis) => (axis ? moneyShort(v) : money(v)) },
      ]} />
    </>
  );
}

function ReceptionDash({ d }) {
  const s = d.stats;
  const nav = useNavigate();
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        <Link to="/patients/new"><Button icon={UserPlus}>Register patient</Button></Link>
        <Link to="/appointments/book"><Button variant="secondary" icon={CalendarPlus}>Book appointment</Button></Link>
        <Link to="/admissions/new"><Button variant="secondary" icon={BedDouble}>Admit patient</Button></Link>
      </div>
      <StatStrip items={[
        { label: "Today's appointments", value: s.todaysAppointments },
        { label: 'New patients today', value: s.newPatientsToday },
        { label: 'Admitted now', value: s.activeAdmissions },
        { label: 'Beds available', value: s.availableBeds, tone: s.availableBeds < 5 ? 'caution' : undefined },
        { label: 'On waitlist', value: s.waitingList },
        { label: 'Admission requests', value: s.pendingAdmissionRequests, tone: s.pendingAdmissionRequests ? 'caution' : undefined },
        { label: 'Ready for discharge', value: s.readyForDischarge },
      ]} />
      <div className="mt-5 grid gap-5 xl:grid-cols-[2fr_1fr]">
        <Panel title="Still to arrive today" bodyClass="" actions={<Link to="/appointments" className="link text-sm">All appointments</Link>}>
          <Table rows={d.upcoming} onRowClick={(a) => nav(`/appointments?date=today&focus=${a.id}`)} empty={<EmptyState icon={ClipboardList} title="No more appointments today" />}
            columns={[
              { header: 'Token', render: (a) => <Token n={a.token} /> , width: 70 },
              { header: 'Time', render: (a) => <span className="font-semibold tabular-nums">{a.time}</span> },
              { header: 'Patient', render: (a) => <><span className="font-semibold">{a.patient}</span><span className="block text-xs text-muted">{a.patientCode}</span></> },
              { header: 'Doctor', key: 'doctor' },
              { header: 'Status', render: (a) => <Status value={a.status} /> },
            ]} />
        </Panel>
        <Panel title="Wards">
          <p className="text-sm">Requests and discharges are listed on the admissions page. The bed board updates live as beds are assigned.</p>
          <div className="mt-3 flex flex-col gap-2">
            <Link to="/admissions"><Button variant="secondary" className="w-full" icon={ClipboardList}>Admissions & requests ({s.pendingAdmissionRequests})</Button></Link>
            <Link to="/wards/board"><Button variant="secondary" className="w-full" icon={BedDouble}>Bed board</Button></Link>
            <Link to="/waitlist"><Button variant="secondary" className="w-full">Waitlist ({s.waitingList})</Button></Link>
          </div>
        </Panel>
      </div>
    </>
  );
}

function DoctorDash({ d }) {
  const s = d.stats;
  const nav = useNavigate();
  return (
    <>
      <StatStrip items={[
        { label: "Today's appointments", value: s.todaysAppointments },
        { label: 'Still waiting', value: s.pendingPatients },
        { label: 'Seen today', value: s.completedToday },
        { label: 'In-patients under my care', value: s.admittedPatients },
        { label: 'Lab results pending', value: s.pendingLabReports },
        { label: 'Prescriptions flagged', value: s.flaggedPrescriptions, tone: s.flaggedPrescriptions ? 'alert' : undefined },
      ]} />
      {s.flaggedPrescriptions > 0 && <Callout tone="alert" className="mt-4" title="The pharmacy flagged a prescription" action={<Link to="/doctor/flagged"><Button size="sm" variant="secondary">Review</Button></Link>}>Correct it so the patient can receive their medicine.</Callout>}
      <div className="mt-5 grid gap-5 xl:grid-cols-[3fr_2fr]">
        <Panel title="Today's queue" bodyClass="" actions={<Link to="/doctor/schedule" className="link text-sm">Full schedule</Link>}>
          {d.todaysAppointments.length === 0 ? <EmptyState icon={Stethoscope} title="No appointments today" /> : (
            <ul>
              {d.todaysAppointments.map((a) => (
                <li key={a.id} className="flex items-center gap-3 border-b border-rule/70 px-4 py-2.5 last:border-0">
                  <Token n={a.token} muted={a.status !== 'scheduled'} />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold"><span className="tabular-nums">{a.time}</span> {a.patient.fullName} <span className="text-sm font-normal text-muted">{a.patient.patientCode}</span></p>
                    <p className="truncate text-xs text-muted">{a.reason || 'Consultation'}</p>
                  </div>
                  <Status value={a.status} />
                  {a.status === 'scheduled' && <Button size="sm" onClick={() => nav(a.visitId ? `/doctor/visits/${a.visitId}` : `/doctor/patients/${a.patient.id}?appointment=${a.id}`)}>{a.visitId ? 'Continue' : 'Start'}</Button>}
                  {a.status !== 'scheduled' && <Button size="sm" variant="ghost" onClick={() => nav(`/doctor/patients/${a.patient.id}`)}>Open</Button>}
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <div className="space-y-5">
          <Panel title="In-patients under my care" bodyClass="">
            {d.admitted.length === 0 ? <p className="px-4 py-4 text-sm text-muted">No admitted patients.</p> : (
              <ul>{d.admitted.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 border-b border-rule/70 px-4 py-2.5 text-sm last:border-0">
                  <Link to={`/doctor/patients/${a.patient.id}`} className="font-semibold hover:underline">{a.patient.fullName}</Link>
                  <span className="text-muted">{a.ward}, {a.bed}</span>
                  {a.dischargeApproved && <Status value="approved" label="Discharge approved" />}
                </li>
              ))}</ul>
            )}
          </Panel>
          <Panel title="New lab results" bodyClass="">
            {d.recentLabResults.length === 0 ? <p className="px-4 py-4 text-sm text-muted">No results yet.</p> : (
              <ul>{d.recentLabResults.map((l) => (
                <li key={l.id} className="border-b border-rule/70 px-4 py-2.5 text-sm last:border-0">
                  <Link to={`/doctor/patients/${l.patient.id}?tab=labs`} className="font-semibold hover:underline">{l.test}</Link> for {l.patient.fullName}
                  <span className="block text-xs text-muted">{relative(l.uploadedAt)}</span>
                </li>
              ))}</ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

function LabDash({ d }) {
  const s = d.stats;
  return (
    <>
      <div className="mb-4"><Link to="/lab/requests"><Button icon={FlaskConical}>Open work queue</Button></Link></div>
      <StatStrip items={[
        { label: 'New requests', value: s.pending },
        { label: 'STAT / urgent waiting', value: s.urgentPending, tone: s.urgentPending ? 'alert' : undefined },
        { label: 'In progress', value: s.inProgress },
        { label: 'Delayed', value: s.delayed, tone: s.delayed ? 'caution' : undefined },
        { label: 'Awaiting report upload', value: s.awaitingUpload },
        { label: 'Reported today', value: s.reportedToday },
        { label: 'Avg processing (30 days)', value: `${s.avgProcessingMinutes} min` },
      ]} />
      <div className="mt-5 grid gap-5 xl:grid-cols-[3fr_2fr]">
        <LabQueuePreview />
        <Panel title="Reports issued per day" subtitle="Last 14 days">
          <ColumnChart data={d.charts.reports} xKey="date" series={[{ key: 'value', label: 'Reports' }]} xFormat={shortDate} title="Reports issued per day" />
        </Panel>
      </div>
    </>
  );
}

function LabQueuePreview() {
  const q = useApi('/lab/requests?status=pending&pageSize=8');
  const nav = useNavigate();
  return (
    <Panel title="Next in the queue" bodyClass="" actions={<Link to="/lab/requests" className="link text-sm">Full queue</Link>}>
      <QueryState query={q}>
        {(r) => <Table rows={r.data} onRowClick={(l) => nav(`/lab/requests/${l.id}`)} empty={<EmptyState icon={FlaskConical} title="No requests waiting" />} columns={[
          { header: 'Urgency', render: (l) => <Status value={l.urgency} /> },
          { header: 'Test', render: (l) => <span className="font-semibold">{l.test.name}</span> },
          { header: 'Patient', render: (l) => l.patient.fullName },
          { header: 'Waiting', render: (l) => relative(l.createdAt) },
          { header: 'Status', render: (l) => <Status value={l.status} /> },
        ]} />}
      </QueryState>
    </Panel>
  );
}

function PharmacyDash({ d }) {
  const s = d.stats;
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        <Link to="/pharmacy/prescriptions"><Button icon={Pill}>Prescription queue</Button></Link>
        <Link to="/pharmacy/inventory"><Button variant="secondary">Inventory</Button></Link>
        <Link to="/pharmacy/expiry"><Button variant="secondary">Expiry tracker</Button></Link>
      </div>
      <StatStrip items={[
        { label: 'Awaiting verification', value: s.pendingPrescriptions },
        { label: 'Over 15 minutes', value: s.overdueVerifications, tone: s.overdueVerifications ? 'alert' : undefined },
        { label: 'Ready to dispense', value: s.awaitingDispensing },
        { label: 'Medicines stocked', value: s.totalMedicines },
        { label: 'Low stock', value: s.lowStock, tone: s.lowStock ? 'caution' : undefined },
        { label: 'Batches expiring ≤ 30 days', value: s.expiringBatches, tone: s.expiringBatches ? 'caution' : undefined },
        { label: 'Expired batches', value: s.expiredBatches, tone: s.expiredBatches ? 'alert' : undefined },
      ]} />
      {s.overdueVerifications > 0 && <Callout tone="alert" className="mt-4" title={`${s.overdueVerifications} prescription(s) have waited more than 15 minutes for verification`} action={<Link to="/pharmacy/prescriptions"><Button size="sm" variant="secondary">Verify now</Button></Link>} />}
      <RxQueuePreview />
    </>
  );
}

function RxQueuePreview() {
  const q = useApi('/pharmacy/prescriptions?status=queue');
  const nav = useNavigate();
  return (
    <Panel className="mt-5" title="Prescription queue" bodyClass="" actions={<Link to="/pharmacy/prescriptions" className="link text-sm">Open queue</Link>}>
      <QueryState query={q}>
        {(r) => <Table rows={r.data.slice(0, 8)} onRowClick={(p) => nav(`/pharmacy/prescriptions/${p.id}`)} empty={<EmptyState icon={Pill} title="The queue is clear" />} columns={[
          { header: 'Prescription', render: (p) => <span className="whitespace-nowrap font-semibold">{p.prescriptionCode}</span> },
          { header: 'Patient', render: (p) => p.patient.fullName },
          { header: 'Doctor', render: (p) => p.doctor.fullName },
          { header: 'Waiting', render: (p) => <span className={p.verificationOverdue ? 'font-semibold text-alert' : ''}>{p.waitingMinutes} min</span> },
          { header: 'Status', render: (p) => <Status value={p.status} /> },
        ]} />}
      </QueryState>
    </Panel>
  );
}

function AccountantDash({ d }) {
  const s = d.stats;
  const q = useApi('/billing/awaiting-final-bill');
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        <Link to="/billing"><Button icon={Receipt}>Billing desk</Button></Link>
        <Link to="/reports/financial"><Button variant="secondary">Financial reports</Button></Link>
      </div>
      <StatStrip items={[
        { label: "Today's revenue", value: moneyShort(s.todaysRevenue) },
        { label: 'Billed today', value: moneyShort(s.billedToday) },
        { label: 'Bills awaiting payment', value: s.pendingPayments },
        { label: 'Outstanding amount', value: moneyShort(s.outstandingAmount), tone: 'caution' },
        { label: 'Paid bills', value: s.paidBills },
        { label: 'Discharges awaiting final bill', value: s.awaitingFinalBill, tone: s.awaitingFinalBill ? 'alert' : undefined },
      ]} />
      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Panel title="Payments received per day" subtitle="Last 14 days">
          <ColumnChart data={d.charts.revenue} xKey="date" series={[{ key: 'value', label: 'Revenue' }]} format={(v, axis) => (axis ? moneyShort(v) : money(v))} xFormat={shortDate} title="Payments received per day" />
        </Panel>
        <Panel title="Discharges waiting for a final bill" bodyClass="">
          <QueryState query={q} empty={{ when: (r) => !r.data.length, render: <p className="px-4 py-4 text-sm text-muted">No discharges are waiting.</p> }}>
            {(r) => <Table rows={r.data} rowKey="admissionId" columns={[
              { header: 'Patient', render: (x) => <Link className="link font-semibold" to={`/billing/patients/${x.patient.id}`}>{x.patient.fullName}</Link> },
              { header: 'Ward', key: 'wardName' },
              { header: 'Approved', render: (x) => relative(x.approvedAt) },
            ]} />}
          </QueryState>
        </Panel>
      </div>
    </>
  );
}

function SysadminDash({ d }) {
  const s = d.stats;
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        <Link to="/system/health"><Button icon={HeartPulse}>System health</Button></Link>
        <Link to="/system/backups"><Button variant="secondary" icon={DatabaseBackup}>Backups</Button></Link>
      </div>
      <StatStrip items={[
        { label: 'Active sessions (last 10 min)', value: s.activeSessions },
        { label: 'Live connections', value: s.liveConnections },
        { label: 'Failed notifications (24 h)', value: s.failedNotifications24h, tone: s.failedNotifications24h ? 'caution' : undefined },
        { label: 'Database size', value: bytes(s.databaseSizeBytes) },
      ]} />
      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <Panel title="Last backup">{d.lastBackup ? <p className="text-sm"><Status value={d.lastBackup.status} /> {d.lastBackup.type} backup, {dateTime(d.lastBackup.at)}{d.lastBackup.sizeBytes ? `, ${bytes(d.lastBackup.sizeBytes)}` : ''}</p> : <p className="text-sm text-muted">No backup has been taken yet. Run one from the Backups page.</p>}</Panel>
        <Panel title="Last health check">{d.lastHealth ? <p className="text-sm"><Status value={d.lastHealth.status} /> {dateTime(d.lastHealth.at)}</p> : <p className="text-sm text-muted">No health check has run yet.</p>}</Panel>
      </div>
    </>
  );
}

const VIEWS = { admin: AdminDash, receptionist: ReceptionDash, doctor: DoctorDash, lab_technician: LabDash, pharmacist: PharmacyDash, accountant: AccountantDash, system_admin: SysadminDash };
