// Reports (SRS FR-30, UC-43 Generate Financial Reports, UC-44 Financial Summaries) and operational reports.
import { useState } from 'react';
import { Download } from 'lucide-react';
import { openFile, qs } from '../api/client.js';
import { useApi } from '../api/hooks.js';
import { ColumnChart } from '../components/charts.jsx';
import { Button, Callout, EmptyState, Input, PageHeader, Panel, QueryState, Select, StatStrip, Table, Tabs, useToast } from '../components/ui.jsx';
import { addDays, date, dateTime, money, moneyShort, titleCase, today } from '../lib/format.js';

function RangePicker({ value, onChange, withPeriod }) {
  const presets = [['Last 7 days', 6], ['Last 30 days', 29], ['Last 90 days', 89]];
  return (
    <div className="flex flex-wrap items-end gap-3">
      {withPeriod && <Select label="Report type" value={value.period} onChange={(e) => onChange({ ...value, period: e.target.value })} options={[{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }]} />}
      <Input label="From" type="date" max={value.to} value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} />
      <Input label="To" type="date" max={today()} value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} />
      <div className="flex gap-1 pb-0.5">{presets.map(([l, n]) => <Button key={l} size="sm" variant="ghost" onClick={() => onChange({ ...value, from: addDays(today(), -n), to: today() })}>{l}</Button>)}</div>
    </div>
  );
}

export function FinancialReportsPage() {
  const summary = useApi('/reports/financial/summary', { refetchInterval: 60_000 });
  const [range, setRange] = useState({ period: 'daily', from: addDays(today(), -29), to: today() });
  const report = useApi(`/reports/financial${qs(range)}`);
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  const pdf = async () => {
    setDownloading(true);
    try { await openFile(`/reports/financial.pdf${qs(range)}`, { download: `financial-report-${range.period}-${range.from}-to-${range.to}.pdf` }); } catch (e) { toast({ tone: 'alert', title: e.message }); } finally { setDownloading(false); }
  };
  return (
    <div>
      <PageHeader way="billing" title="Financial reports" subtitle="Live summary of hospital finances, plus daily, weekly or monthly reports you can export as PDF." />
      <QueryState query={summary}>
        {(s) => (s.hasData ? (
          <StatStrip items={[
            { label: 'Revenue received (all time)', value: moneyShort(s.totalRevenue) },
            { label: "Today's revenue", value: moneyShort(s.todaysRevenue) },
            { label: 'This month', value: moneyShort(s.monthRevenue) },
            { label: 'Total billed', value: moneyShort(s.totalBilled) },
            { label: 'Insurance covered', value: moneyShort(s.totalInsurance) },
            { label: `Outstanding (${s.outstandingBills} bills)`, value: moneyShort(s.outstanding), tone: s.outstanding ? 'caution' : undefined },
          ]} />
        ) : <Callout tone="info" title="No financial records found">Figures appear here once bills are generated.</Callout>)}
      </QueryState>
      <Panel className="mt-5" title="Report" actions={<Button icon={Download} variant="secondary" loading={downloading} disabled={!report.data?.hasData} onClick={pdf}>Export PDF</Button>}>
        <RangePicker value={range} onChange={setRange} withPeriod />
        <div className="mt-5">
          <QueryState query={report}>
            {(r) => (!r.hasData ? <EmptyState title="No data available for the selected period" /> : (
              <>
                <ColumnChart data={r.rows} xKey="period" title="Billed and collected" series={[{ key: 'billed', label: 'Billed' }, { key: 'collected', label: 'Collected' }]} format={(v, axis) => (axis ? moneyShort(v) : money(v))} xFormat={(d) => date(d).replace(/ \d{4}$/, '')} height={260} />
                <div className="mt-5 grid gap-5 lg:grid-cols-2">
                  <Table rows={[...r.rows, { period: 'Total', ...r.totals }]} rowKey="period" columns={[
                    { header: r.period === 'weekly' ? 'Week starting' : r.period === 'monthly' ? 'Month' : 'Day', render: (x) => (x.period === 'Total' ? <strong>Total</strong> : r.period === 'monthly' ? date(x.period).replace(/^\d+ /, '') : date(x.period)) },
                    { header: 'Bills', key: 'bills', className: 'text-right' }, { header: 'Billed', render: (x) => money(x.billed), className: 'text-right' },
                    { header: 'Insurance', render: (x) => money(x.insurance), className: 'text-right' }, { header: 'Collected', render: (x) => money(x.collected), className: 'text-right' },
                  ]} />
                  <div className="space-y-4">
                    <Table rows={r.byCategory} rowKey="category" columns={[{ header: 'Billed by service', render: (x) => titleCase(x.category) }, { header: 'Amount', render: (x) => money(x.amount), className: 'text-right' }]} />
                    <Table rows={r.byMethod} rowKey="method" columns={[{ header: 'Payments by method', render: (x) => titleCase(x.method) }, { header: 'Count', key: 'n', className: 'text-right' }, { header: 'Amount', render: (x) => money(x.amount), className: 'text-right' }]} />
                    <p className="text-sm">Outstanding at end of period: <strong>{money(r.outstandingAtEnd)}</strong></p>
                  </div>
                </div>
                <p className="mt-3 text-xs text-muted">Generated {dateTime(r.generatedAt)}.</p>
              </>
            ))}
          </QueryState>
        </div>
      </Panel>
    </div>
  );
}

export function OperationalReportsPage() {
  const [range, setRange] = useState({ from: addDays(today(), -29), to: today() });
  const q = useApi(`/reports/operational${qs(range)}`);
  const [tab, setTab] = useState('overview');
  return (
    <div>
      <PageHeader way="admin" title="Operational reports" subtitle="Patients, appointments, doctor workload, wards, laboratory and pharmacy." />
      <Panel className="mb-5"><RangePicker value={range} onChange={setRange} /></Panel>
      <QueryState query={q}>
        {(r) => (
          <>
            <StatStrip items={[
              { label: 'New patients', value: r.patients.newInPeriod },
              { label: 'Appointments', value: r.appointments.total },
              { label: 'Beds occupied', value: `${r.beds.occupied} / ${r.beds.total}` },
              { label: 'Avg lab processing', value: `${r.laboratory.avgProcessingMinutes} min` },
              { label: 'Low-stock medicines', value: r.pharmacy.lowStockMedicines },
            ]} />
            <div className="mt-5"><Tabs value={tab} onChange={setTab} tabs={[{ value: 'overview', label: 'Appointments & patients' }, { value: 'doctors', label: 'Doctor workload' }, { value: 'wards', label: 'Ward occupancy' }, { value: 'lab', label: 'Laboratory' }, { value: 'pharmacy', label: 'Pharmacy' }]} /></div>
            {tab === 'overview' && (
              <div className="grid gap-5 lg:grid-cols-2">
                <Panel title="Appointments by status" bodyClass=""><Table rows={r.appointments.byStatus} rowKey="status" columns={[{ header: 'Status', render: (x) => titleCase(x.status) }, { header: 'Count', key: 'n', className: 'text-right' }]} /></Panel>
                <Panel title="Patients by current status" bodyClass=""><Table rows={r.patients.byStatus} rowKey="status" columns={[{ header: 'Status', render: (x) => titleCase(x.status) }, { header: 'Patients', key: 'n', className: 'text-right' }]} /></Panel>
              </div>
            )}
            {tab === 'doctors' && (
              <Panel title="Doctor workload" bodyClass="">
                <Table rows={r.doctorWorkload} rowKey="doctorId" columns={[
                  { header: 'Doctor', render: (d) => <><p className="font-semibold">{d.doctor}</p><p className="text-xs text-muted">{d.specialization}</p></> },
                  { header: 'Appointments', key: 'appointments', className: 'text-right' }, { header: 'Completed', key: 'completed', className: 'text-right' }, { header: 'Visits', key: 'visits', className: 'text-right' },
                  { header: 'Prescriptions', key: 'prescriptions', className: 'text-right' }, { header: 'In-patients now', key: 'inpatients', className: 'text-right' },
                ]} />
              </Panel>
            )}
            {tab === 'wards' && (
              <Panel title="Ward occupancy (now)">
                <ColumnChart data={r.wardOccupancy} xKey="name" title="Occupancy by ward" series={[{ key: 'occupancyPercent', label: 'Occupancy %' }]} format={(v) => `${v}%`} height={240} />
                <Table className="mt-4" rows={r.wardOccupancy} columns={[{ header: 'Ward', key: 'name' }, { header: 'Beds', key: 'total', className: 'text-right' }, { header: 'Occupied', key: 'occupied', className: 'text-right' }, { header: 'Available', key: 'available', className: 'text-right' }, { header: 'Occupancy', render: (w) => `${w.occupancyPercent}%`, className: 'text-right' }]} />
              </Panel>
            )}
            {tab === 'lab' && (
              <Panel title="Lab tests requested" bodyClass="">
                <Table rows={r.laboratory.byTest} rowKey="name" empty={<EmptyState title="No lab requests in this period" />} columns={[{ header: 'Test', key: 'name' }, { header: 'Requested', key: 'n', className: 'text-right' }, { header: 'Reported', key: 'reported', className: 'text-right' }]} />
              </Panel>
            )}
            {tab === 'pharmacy' && (
              <Panel title="Most dispensed medicines" bodyClass="">
                <Table rows={r.pharmacy.topDispensed} rowKey="name" empty={<EmptyState title="Nothing dispensed in this period" />} columns={[{ header: 'Medicine', render: (m) => `${m.name} ${m.strength}` }, { header: 'Units issued', key: 'qty', className: 'text-right' }]} />
              </Panel>
            )}
          </>
        )}
      </QueryState>
    </div>
  );
}
