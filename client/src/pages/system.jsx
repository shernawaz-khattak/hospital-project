// System & admin services (SRS 5.10: UC-45 Backup, UC-46 Health check, UC-47 notifications) + audit log + inbox.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, DatabaseBackup, Download, HeartPulse, RefreshCw } from 'lucide-react';
import { openFile, post, qs } from '../api/client.js';
import { useAction, useApi } from '../api/hooks.js';
import { Button, Callout, EmptyState, Input, KeyValue, PageHeader, Pagination, Panel, QueryState, Select, Status, Table, cx, useToast } from '../components/ui.jsx';
import { bytes, date, dateTime, relative, titleCase } from '../lib/format.js';

export function HealthPage() {
  const q = useApi('/system/health');
  const [result, setResult] = useState(null);
  const run = useAction(() => post('/system/health/run'), { invalidate: ['system'], onSuccess: setResult, success: (r) => `Health check complete: ${r.overall}` });
  const latest = result ?? (q.data?.latest && { ...q.data.latest, checkedAt: q.data.latest.checkedAt });
  return (
    <div>
      <PageHeader way="system" title="System health" subtitle="Checks server, database connectivity, performance, storage, backups and notifications. Runs automatically every hour and alerts you on problems." actions={<Button icon={HeartPulse} loading={run.isPending} onClick={() => run.mutate()}>Run check now</Button>} />
      {!latest && !q.isLoading && <Callout tone="info" title="No health check has run yet">Run one now to see the status of every component.</Callout>}
      {latest && (
        <>
          <div className={cx('mb-5 flex items-center gap-4 rounded-panel border p-4', latest.overall === 'healthy' ? 'border-ok/30 bg-ok-light' : latest.overall === 'degraded' ? 'border-caution/30 bg-caution-light' : 'border-alert/30 bg-alert-light')}>
            <p className="font-sign text-3xl font-semibold capitalize">{latest.overall}</p>
            <p className="text-sm">Checked {dateTime(latest.checkedAt)} ({latest.checkType}), took {latest.durationMs} ms.</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {latest.components.map((c) => (
              <Panel key={c.name} title={c.name} actions={<Status value={c.status} />}>
                <p className="text-sm">{c.detail}</p>
                {c.name === 'Scheduled jobs' && c.metrics.jobs && <ul className="mt-2 space-y-1 text-xs text-muted">{c.metrics.jobs.map((j) => <li key={j.name}>{j.name} <code>{j.expression}</code>{j.lastRunAt ? `, last ran ${relative(j.lastRunAt)} (${j.lastStatus})` : ', not run yet'}</li>)}</ul>}
                {c.name === 'API performance' && c.metrics.sampleSize > 0 && <p className="mt-2 text-xs text-muted">Average {c.metrics.avgMs} ms, median {c.metrics.p50Ms} ms, slowest {c.metrics.maxMs} ms. {c.metrics.totalRequests} requests since start, {c.metrics.serverErrors} server errors. Target: under 3 s.</p>}
                {c.name === 'Database connectivity' && c.metrics.sizeBytes && <p className="mt-2 text-xs text-muted">Size {bytes(c.metrics.sizeBytes)}, {c.metrics.connections} connections (pool max {c.metrics.poolMax}).</p>}
                {c.name === 'Application server' && <p className="mt-2 text-xs text-muted">Memory {bytes(c.metrics.rssBytes)}, Node {c.metrics.node}, {c.metrics.cpus} CPUs, load {c.metrics.loadAverage?.join(' / ')}</p>}
              </Panel>
            ))}
          </div>
        </>
      )}
      <Panel className="mt-5" title="History" bodyClass="">
        <QueryState query={q}>{(r) => <Table rows={r.history} empty={<p className="px-4 py-4 text-sm text-muted">No history yet.</p>} columns={[{ header: 'When', render: (h) => dateTime(h.checkedAt) }, { header: 'Result', render: (h) => <Status value={h.overall} /> }, { header: 'Type', render: (h) => titleCase(h.checkType) }, { header: 'Duration', render: (h) => `${h.durationMs} ms` }]} />}</QueryState>
      </Panel>
    </div>
  );
}

export function BackupsPage() {
  const q = useApi('/system/backups', { refetchInterval: 15_000 });
  const toast = useToast();
  const run = useAction(() => post('/system/backups'), { invalidate: ['system'], success: (r) => r.message });
  return (
    <div>
      <PageHeader way="system" title="Backups" subtitle="Compressed PostgreSQL backups (pg_dump custom format, restorable with pg_restore)." actions={<Button icon={DatabaseBackup} loading={run.isPending || q.data?.running} onClick={() => run.mutate()}>Back up now</Button>} />
      <QueryState query={q}>
        {(r) => (
          <>
            {!r.schedulerEnabled && <Callout tone="caution" className="mb-4" title="Automatic backups are switched off">The scheduler is disabled on this server (ENABLE_SCHEDULER=false). Daily backups will not run until it is enabled.</Callout>}
            <Panel className="mb-5"><KeyValue cols={3} items={[['Automatic schedule', r.schedule === '0 0 * * *' ? 'Every day at midnight' : <code>{r.schedule}</code>], ['Retention', `Files kept for ${r.retentionDays} days`], ['Last successful backup', r.data.find((b) => b.status === 'success') ? dateTime(r.data.find((b) => b.status === 'success').completedAt) : 'None yet']]} /></Panel>
            <Panel bodyClass="">
              <Table rows={r.data} empty={<EmptyState icon={DatabaseBackup} title="No backups yet" action={<Button onClick={() => run.mutate()}>Run the first backup</Button>} />} columns={[
                { header: 'Started', render: (b) => dateTime(b.startedAt) }, { header: 'Type', render: (b) => titleCase(b.type) }, { header: 'Status', render: (b) => <Status value={b.status} /> },
                { header: 'Size', render: (b) => bytes(b.sizeBytes) }, { header: 'Triggered by', key: 'triggeredByName' },
                { header: 'Checksum / error', render: (b) => (b.error ? <span className="text-xs text-alert">{b.error}</span> : <code className="text-xs text-muted">{b.sha256?.slice(0, 16)}…</code>) },
                { header: '', render: (b) => b.downloadable && <Button size="sm" variant="ghost" icon={Download} onClick={() => openFile(`/system/backups/${b.id}/download`, { download: b.fileName }).catch((e) => toast({ tone: 'alert', title: e.message }))}>Download</Button> },
              ]} />
            </Panel>
          </>
        )}
      </QueryState>
    </div>
  );
}

export function NotificationLogPage() {
  const [f, setF] = useState({ status: '', channel: '' });
  const q = useApi(`/system/notification-log${qs(f)}`);
  return (
    <div>
      <PageHeader way="system" title="Notification log" subtitle="Delivery of every notification. Emails are retried up to 3 times, 15 seconds apart." />
      <Callout tone="info" className="mb-4">In-app notifications are delivered instantly. “Captured (dev outbox)” means email delivery is not configured, so the message was stored locally and was not sent.</Callout>
      <Panel bodyClass="">
        <div className="flex flex-wrap gap-3 border-b border-rule p-3">
          <select className="field-input w-44" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} aria-label="Channel"><option value="">All channels</option><option value="in_app">In-app</option><option value="email">Email</option></select>
          <select className="field-input w-48" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label="Status"><option value="">All statuses</option>{['pending', 'delivered', 'captured', 'failed', 'skipped'].map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</select>
        </div>
        <QueryState query={q}>
          {(r) => <Table rows={r.data} empty={<EmptyState title="No deliveries" />} columns={[
            { header: 'Created', render: (d) => dateTime(d.created_at) }, { header: 'Event', render: (d) => <><p className="font-semibold">{d.title}</p><p className="text-xs text-muted">{d.event_type}</p></> },
            { header: 'Channel', render: (d) => (d.channel === 'in_app' ? 'In-app' : 'Email') }, { header: 'Recipient', key: 'recipient' },
            { header: 'Status', render: (d) => <Status value={d.status} /> }, { header: 'Attempts', key: 'attempts' }, { header: 'Error', render: (d) => <span className="text-xs text-alert">{d.last_error}</span> },
          ]} />}
        </QueryState>
      </Panel>
    </div>
  );
}

export function AuditLogPage() {
  const [f, setF] = useState({ q: '', action: '', status: '', from: '', to: '', page: 1 });
  const q = useApi(`/system/audit${qs({ ...f, pageSize: 50 })}`);
  const [open, setOpen] = useState(null);
  return (
    <div>
      <PageHeader way="system" title="Audit log" subtitle="Every sign-in, change and access decision. Entries cannot be edited or deleted." />
      <Panel bodyClass="">
        <div className="flex flex-wrap items-end gap-3 border-b border-rule p-3">
          <Input label="User or action" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} />
          <Select label="Action" placeholder="All actions" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value, page: 1 })} options={(q.data?.actions ?? []).map((a) => ({ value: a, label: a }))} />
          <Select label="Result" placeholder="Any result" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })} options={[{ value: 'success', label: 'Success' }, { value: 'failure', label: 'Failure' }, { value: 'denied', label: 'Denied' }]} />
          <Input label="From" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, page: 1 })} />
          <Input label="To" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value, page: 1 })} />
        </div>
        <QueryState query={q}>
          {(r) => (
            <>
              <Table rows={r.data} onRowClick={(e) => setOpen(open === e.id ? null : e.id)} empty={<EmptyState title="No entries match" />} columns={[
                { header: 'When', render: (e) => <span className="whitespace-nowrap">{dateTime(e.at)}</span> },
                { header: 'User', render: (e) => <>{e.username ?? 'system'}<span className="block text-xs text-muted">{e.role ?? ''}</span></> },
                { header: 'Action', render: (e) => <code className="text-xs">{e.action}</code> },
                { header: 'Record', render: (e) => (e.entityType ? `${e.entityType} #${e.entityId}` : '—') },
                { header: 'Result', render: (e) => <Status value={e.status} /> },
                { header: 'Details', render: (e) => (e.details ? <span className="block max-w-md truncate text-xs text-muted" title={JSON.stringify(e.details)}>{open === e.id ? <pre className="whitespace-pre-wrap">{JSON.stringify(e.details, null, 2)}</pre> : JSON.stringify(e.details)}</span> : '') },
                { header: 'IP', render: (e) => <span className="text-xs">{e.ip}</span> },
              ]} />
              <Pagination page={r.page} pageSize={r.pageSize} total={r.total} onChange={(page) => setF({ ...f, page })} />
            </>
          )}
        </QueryState>
      </Panel>
    </div>
  );
}

export function NotificationsPage() {
  const [unread, setUnread] = useState(false);
  const [page, setPage] = useState(1);
  const q = useApi(`/notifications${qs({ unread: unread ? 'true' : undefined, page, pageSize: 30 })}`);
  const readAll = useAction(() => post('/notifications/read-all'), { invalidate: ['notifications'] });
  const read = useAction((id) => post(`/notifications/${id}/read`), { invalidate: ['notifications'] });
  return (
    <div className="max-w-3xl">
      <PageHeader way="home" title="Notifications" actions={<><Button size="sm" variant={unread ? 'primary' : 'secondary'} onClick={() => { setUnread(!unread); setPage(1); }}>{unread ? 'Showing unread' : 'Show unread only'}</Button><Button size="sm" variant="secondary" icon={CheckCircle2} onClick={() => readAll.mutate()}>Mark all read</Button></>} />
      <Panel bodyClass="">
        <QueryState query={q}>
          {(r) => (r.data.length === 0 ? <EmptyState title="No notifications" /> : (
            <>
              <ul>
                {r.data.map((n) => (
                  <li key={n.id} className={cx('flex gap-3 border-b border-rule/70 px-4 py-3 last:border-0', !n.isRead && 'bg-scrub-light/40')}>
                    <span className={cx('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', n.isRead ? 'bg-transparent' : n.priority === 'high' ? 'bg-alert' : 'bg-scrub')} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{n.link ? <Link to={n.link} className="hover:underline" onClick={() => !n.isRead && read.mutate(n.id)}>{n.title}</Link> : n.title}</p>
                      <p className="text-sm">{n.message}</p>
                      <p className="mt-0.5 text-xs text-muted">{dateTime(n.createdAt)}</p>
                    </div>
                    {!n.isRead && <Button size="sm" variant="ghost" onClick={() => read.mutate(n.id)}>Mark read</Button>}
                  </li>
                ))}
              </ul>
              <Pagination page={r.page} pageSize={r.pageSize} total={r.total} onChange={setPage} />
            </>
          ))}
        </QueryState>
      </Panel>
    </div>
  );
}

