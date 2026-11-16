import { useMemo, useState } from 'react';
import { put } from '../api/client.js';
import { useAction, useApi } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { Button, PageHeader, Panel, QueryState, Select, Status, Table } from '../components/ui.jsx';

const SHIFTS = {
  morning: { label: 'Morning', tone: 'ok' },
  evening: { label: 'Evening', tone: 'caution' },
  night: { label: 'Night', tone: 'alert' },
  off: { label: 'Off', tone: 'neutral' },
};

const currentMonth = () => new Date().toISOString().slice(0, 7);

function daysInMonth(month) {
  const [year, number] = month.split('-').map(Number);
  return Array.from({ length: new Date(year, number, 0).getDate() }, (_, i) => i + 1);
}

function rosterMap(roster) {
  return Object.fromEntries(roster.map((item) => [`${item.staffId}:${item.date}`, item.shift]));
}

function NurseRoster({ editable = false }) {
  const [month, setMonth] = useState(currentMonth());
  const q = useApi(`/nurses/roster?month=${month}`);
  const [draft, setDraft] = useState({});
  const days = useMemo(() => daysInMonth(month), [month]);
  const save = useAction(() => {
    const entries = [];
    const existing = rosterMap(q.data?.roster ?? []);
    for (const nurse of q.data?.nurses ?? []) {
      for (const day of days) {
        const date = `${month}-${String(day).padStart(2, '0')}`;
        const key = `${nurse.id}:${date}`;
        entries.push({ staffId: nurse.id, date, shift: draft[key] ?? existing[key] ?? 'off' });
      }
    }
    return put('/nurses/roster', { month, entries });
  }, { success: 'Monthly roster saved', invalidate: ['nurses'], onSuccess: () => setDraft({}) });

  const setShift = (staffId, date, shift) => setDraft((old) => ({ ...old, [`${staffId}:${date}`]: shift }));
  const monthChanged = (value) => { setMonth(value); setDraft({}); };

  return (
    <Panel bodyClass="overflow-x-auto">
      <div className="flex items-center gap-3 border-b border-rule p-3">
        <label className="text-sm font-semibold" htmlFor="roster-month">Month</label>
        <input id="roster-month" className="field-input w-44" type="month" value={month} onChange={(e) => monthChanged(e.target.value)} />
        {editable && <Button className="ml-auto" loading={save.isPending} onClick={() => save.mutate()}>Save roster</Button>}
      </div>
      <QueryState query={q}>{(result) => {
        const values = { ...rosterMap(result.roster), ...draft };
        return (
          <Table rows={result.nurses} empty={<p className="p-4 text-sm text-muted">No nurses found.</p>} columns={[
            { header: 'Nurse', key: 'fullName', render: (nurse) => <span className="font-semibold whitespace-nowrap">{nurse.fullName}</span> },
            ...days.map((day) => {
              const date = `${month}-${String(day).padStart(2, '0')}`;
              return {
                header: String(day).padStart(2, '0'),
                className: 'text-center',
                render: (nurse) => {
                  const key = `${nurse.id}:${date}`;
                  const shift = values[key];
                  if (!editable) return shift ? <Status value={shift} label={SHIFTS[shift].label} tone={SHIFTS[shift].tone} /> : <span className="text-xs text-muted">—</span>;
                  return (
                    <select className="field-input min-w-24 text-xs" value={shift ?? 'off'} onChange={(e) => setShift(nurse.id, date, e.target.value)} aria-label={`${nurse.fullName}, day ${day}`}>
                      {Object.entries(SHIFTS).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}
                    </select>
                  );
                },
              };
            }),
          ]} />
        );
      }}</QueryState>
    </Panel>
  );
}

export function AdminNurseRosterPage() {
  return (
    <div>
      <PageHeader way="admin" title="Nurse roster" subtitle="Assign each nurse to Morning, Evening, Night or Off for the selected month." />
      <NurseRoster editable />
    </div>
  );
}

export function MyNurseRosterPage() {
  const { user } = useAuth();
  return (
    <div>
      <PageHeader way="clinical" title="My monthly roster" subtitle={`Duty roster for ${user.fullName}`} />
      <NurseRoster />
    </div>
  );
}

export function NurseRosterPage() {
  const { user, can } = useAuth();
  const editable = can('nursing.roster.manage');
  return (
    <div>
      <PageHeader
        way="clinical"
        title="Nurse roster"
        subtitle={editable ? 'Assign Morning, Evening, Night or Off duty for each nurse.' : `Duty roster for ${user.fullName}`}
      />
      <NurseRoster editable={editable} />
    </div>
  );
}
