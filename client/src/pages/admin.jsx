// Administration (SRS 5.3: UC-05..UC-11) and cancellation approvals (UC-16 2-A).
import { useEffect, useMemo, useState } from 'react';
import { KeyRound, Pencil, Plus, Trash2, Unlock, UserPlus } from 'lucide-react';
import { del, patch, post, put, qs } from '../api/client.js';
import { useAction, useApi } from '../api/hooks.js';
import { useAuth } from '../auth/AuthProvider.jsx';
import { Button, Callout, Checkbox, EmptyState, Input, KeyValue, Modal, PageHeader, Pagination, Panel, QueryState, Select, Status, Table, Textarea, cx, useConfirm, useForm } from '../components/ui.jsx';
import { ROLE_LABEL, WEEKDAYS, date, dateTime, money, relative, time } from '../lib/format.js';

const STAFF_ROLES = ['receptionist', 'nurse', 'lab_technician', 'pharmacist', 'accountant', 'admin', 'system_admin'];

function useDepartments() {
  return useApi('/departments');
}

/** Shows a one-time temporary password after creating an account or resetting it. */
function TempPasswordModal({ value, onClose }) {
  return (
    <Modal open={Boolean(value)} onClose={onClose} title="Temporary password" width="max-w-md" footer={<Button onClick={onClose}>Done</Button>}>
      <p className="text-sm">Give this password to <strong>{value?.name}</strong> in person. It is shown only once; they must change it when they first sign in.</p>
      <p className="mt-3 select-all rounded border border-rule bg-paper px-3 py-2 text-center font-mono text-lg tracking-wide">{value?.password}</p>
      {value?.emailed && <p className="mt-2 text-xs text-muted">A message with their username and a link to set a password was also queued to their email.</p>}
    </Modal>
  );
}

// ----------------------------------------------------------------- users
export function UsersPage() {
  const [filters, setFilters] = useState({ search: '', role: '', status: '', page: 1 });
  const q = useApi(`/users${qs({ ...filters, pageSize: 20 })}`);
  const deps = useDepartments();
  const confirm = useConfirm();
  const { user: me } = useAuth();
  const [editing, setEditing] = useState(null);
  const [temp, setTemp] = useState(null);

  const remove = useAction((u) => del(`/users/${u.id}`, { reason: 'Removed by administrator' }), { success: 'User archived and removed', invalidate: ['users', 'staff'] });
  const unlock = useAction((u) => post(`/users/${u.id}/unlock`), { success: 'Account unlocked', invalidate: ['users'] });
  const reset = useAction((u) => post(`/users/${u.id}/reset-password`), { onSuccess: (r, u) => setTemp({ name: u.fullName, password: r.tempPassword }) });

  return (
    <div>
      <PageHeader way="admin" title="Users" subtitle="Staff accounts and their roles. Doctors are added from Doctors; patient accounts from the patient's profile." actions={<Button icon={UserPlus} onClick={() => setEditing({})}>Add user</Button>} />
      <Panel bodyClass="">
        <div className="flex flex-wrap gap-3 border-b border-rule p-3">
          <input className="field-input max-w-xs" placeholder="Search name, username, email" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value, page: 1 })} aria-label="Search users" />
          <select className="field-input w-48" value={filters.role} onChange={(e) => setFilters({ ...filters, role: e.target.value, page: 1 })} aria-label="Role"><option value="">All roles</option>{Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <select className="field-input w-40" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value, page: 1 })} aria-label="Status"><option value="">Any status</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
        </div>
        <QueryState query={q}>
          {(r) => (
            <>
              <Table rows={r.data} empty={<EmptyState title="No users match these filters" />} columns={[
                { header: 'Name', render: (u) => <><p className="font-semibold">{u.fullName}</p><p className="text-xs text-muted">{u.username}{u.employeeCode ? `, ${u.employeeCode}` : ''}</p></> },
                { header: 'Role', render: (u) => ROLE_LABEL[u.role] },
                { header: 'Department', render: (u) => u.departmentName ?? '—' },
                { header: 'Email', key: 'email' },
                { header: 'Status', render: (u) => <div className="flex flex-wrap gap-1"><Status value={u.status} />{u.locked && <Status value="locked" label="Locked" tone="alert" />}{u.mustChangePassword && <Status value="temp" label="Temp password" tone="caution" />}</div> },
                { header: 'Last sign-in', render: (u) => (u.lastLoginAt ? relative(u.lastLoginAt) : 'Never') },
                {
                  header: '', className: 'text-right', render: (u) => (
                    <div className="flex justify-end gap-1">
                      {u.locked && <Button size="sm" variant="ghost" icon={Unlock} onClick={() => unlock.mutate(u)} title="Unlock">Unlock</Button>}
                      {u.role !== 'patient' && <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(u)} aria-label={`Edit ${u.fullName}`} />}
                      <Button size="sm" variant="ghost" icon={KeyRound} aria-label={`Reset password for ${u.fullName}`} onClick={async () => (await confirm({ title: 'Reset password?', message: `${u.fullName} will be signed out everywhere and must sign in with a new temporary password.`, confirmLabel: 'Reset password' })) && reset.mutate(u)} />
                      {u.id !== me.id && <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Delete ${u.fullName}`} onClick={async () => (await confirm({ title: 'Delete user?', danger: true, confirmLabel: 'Delete user', message: <>The account of <strong>{u.fullName}</strong> will be archived for audit purposes and removed. They will no longer be able to sign in.</> })) && remove.mutate(u)} />}
                    </div>
                  ),
                },
              ]} />
              <Pagination page={r.page} pageSize={r.pageSize} total={r.total} onChange={(page) => setFilters({ ...filters, page })} />
            </>
          )}
        </QueryState>
      </Panel>
      {editing && <UserForm user={editing} deps={deps.data?.data ?? []} onClose={() => setEditing(null)} onCreated={(r, name) => setTemp({ name, password: r.tempPassword, emailed: true })} />}
      <TempPasswordModal value={temp} onClose={() => setTemp(null)} />
    </div>
  );
}

function UserForm({ user, deps, onClose, onCreated }) {
  const isNew = !user.id;
  const f = useForm({ username: '', fullName: user.fullName ?? '', email: user.email ?? '', phone: user.phone ?? '', role: user.role ?? '', departmentId: user.departmentId ?? '', designation: user.designation ?? '', status: user.status ?? 'active' });
  const save = useAction((v) => (isNew ? post('/users', v) : patch(`/users/${user.id}`, v)), {
    success: isNew ? 'User created' : 'User updated', invalidate: ['users', 'staff'], onError: (e) => { f.fromError(e); return Boolean(e.fields); },
    onSuccess: (r) => { if (isNew) onCreated(r, f.values.fullName); onClose(); },
  });
  const submit = (e) => {
    e.preventDefault();
    const { username, status, ...rest } = f.values;
    save.mutate(isNew ? { username, ...rest } : { ...rest, status });
  };
  return (
    <Modal open onClose={onClose} title={isNew ? 'Add user' : `Edit ${user.fullName}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="user-form" loading={save.isPending}>{isNew ? 'Create user' : 'Save changes'}</Button></>}>
      <form id="user-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        {isNew && <Input label="Username" required className="sm:col-span-2" hint="Letters, numbers, dot, dash or underscore" {...f.bind('username')} />}
        <Input label="Full name" required {...f.bind('fullName')} />
        <Input label="Email" type="email" required {...f.bind('email')} />
        <Input label="Phone" {...f.bind('phone')} />
        <Select label="Role" required placeholder="Choose a role" options={(user.role === 'doctor' ? ['doctor'] : STAFF_ROLES).map((r) => ({ value: r, label: ROLE_LABEL[r] }))} disabled={user.role === 'doctor'} {...f.bind('role')} hint={!isNew ? 'Role changes take effect at the next sign-in.' : undefined} />
        <Select label="Department" placeholder="None" options={deps.map((d) => ({ value: d.id, label: d.name }))} {...f.bind('departmentId')} />
        <Input label="Designation" {...f.bind('designation')} />
        {!isNew && <Select label="Account status" options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive (cannot sign in)' }]} {...f.bind('status')} />}
      </form>
    </Modal>
  );
}

// ----------------------------------------------------------------- roles matrix (FR-05)
export function RolesPage() {
  const q = useApi('/users/roles');
  const [role, setRole] = useState('receptionist');
  const [selected, setSelected] = useState(null);
  const current = q.data?.roles.find((r) => r.code === role);
  useEffect(() => { if (current) setSelected(new Set(current.permissions)); }, [current]);
  const save = useAction(() => put(`/users/roles/${role}/permissions`, { permissions: [...selected] }), { success: 'Permissions saved. They apply from each user\'s next sign-in.', invalidate: ['users'] });
  const modules = useMemo(() => {
    const m = {};
    for (const p of q.data?.permissions ?? []) (m[p.module] ??= []).push(p);
    return m;
  }, [q.data]);
  return (
    <div>
      <PageHeader way="admin" title="Roles & permissions" subtitle="Choose what each role may do. Changes take effect when users next sign in." />
      <QueryState query={q}>
        {(d) => (
          <div className="grid gap-5 lg:grid-cols-[240px_1fr]">
            <Panel bodyClass="p-2">
              <ul>{d.roles.map((r) => (
                <li key={r.code}><button onClick={() => setRole(r.code)} className={cx('w-full rounded px-3 py-2 text-left text-sm', role === r.code ? 'bg-scrub-light font-semibold' : 'hover:bg-paper')}>{r.name}<span className="block text-xs text-muted">{r.permissions.length} permissions</span></button></li>
              ))}</ul>
            </Panel>
            <Panel title={current?.name} subtitle={current?.description} actions={<Button onClick={() => save.mutate()} loading={save.isPending}>Save permissions</Button>}>
              {selected && (
                <div className="grid gap-5 md:grid-cols-2">
                  {Object.entries(modules).map(([mod, perms]) => (
                    <fieldset key={mod}>
                      <legend className="mb-2 font-sign text-lg font-semibold capitalize">{mod}</legend>
                      <div className="space-y-2">
                        {perms.map((p) => (
                          <Checkbox key={p.code} label={p.description} hint={p.code} checked={selected.has(p.code)}
                            onChange={(e) => { const s = new Set(selected); e.target.checked ? s.add(p.code) : s.delete(p.code); setSelected(s); }} />
                        ))}
                      </div>
                    </fieldset>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        )}
      </QueryState>
    </div>
  );
}

// ----------------------------------------------------------------- doctors (UC-08)
export function DoctorsPage() {
  const [search, setSearch] = useState('');
  const q = useApi(`/doctors${qs({ search, includeInactive: 'true' })}`);
  const deps = useDepartments();
  const [editing, setEditing] = useState(null);
  const [temp, setTemp] = useState(null);
  const confirm = useConfirm();
  const remove = useAction((d) => del(`/doctors/${d.id}`), { success: 'Doctor removed', invalidate: ['doctors', 'users'] });
  return (
    <div>
      <PageHeader way="admin" title="Doctors" subtitle="Profiles, specializations, fees and weekly availability." actions={<Button icon={Plus} onClick={() => setEditing({})}>Add doctor</Button>} />
      <Panel bodyClass="">
        <div className="border-b border-rule p-3"><input className="field-input max-w-sm" placeholder="Search name, ID or specialization" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search doctors" /></div>
        <QueryState query={q}>
          {(r) => (
            <Table rows={r.data} empty={<EmptyState title="No doctors found" />} columns={[
              { header: 'Doctor ID', render: (d) => <span className="font-semibold">{d.doctorCode}</span> },
              { header: 'Name', render: (d) => <><p className="font-semibold">{d.fullName}</p><p className="text-xs text-muted">{d.qualification}</p></> },
              { header: 'Specialization', key: 'specialization' },
              { header: 'Department', key: 'departmentName' },
              { header: 'Fee', render: (d) => money(d.consultationFee) },
              { header: 'Availability', render: (d) => <span className="text-xs">{summariseSchedule(d.schedules)}</span> },
              { header: 'Status', render: (d) => <Status value={d.isActive ? 'active' : 'inactive'} /> },
              { header: '', className: 'text-right', render: (d) => <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(d)} aria-label={`Edit ${d.fullName}`} /><Button size="sm" variant="ghost" icon={Trash2} aria-label={`Remove ${d.fullName}`} onClick={async () => (await confirm({ title: 'Remove doctor?', danger: true, confirmLabel: 'Remove', message: `${d.fullName}'s account will be archived and removed. Doctors with upcoming appointments or admitted patients cannot be removed.` })) && remove.mutate(d)} /></div> },
            ]} />
          )}
        </QueryState>
      </Panel>
      {editing && <DoctorForm doctor={editing} deps={deps.data?.data ?? []} onClose={() => setEditing(null)} onCreated={(r, name) => setTemp({ name, password: r.tempPassword, emailed: true })} />}
      <TempPasswordModal value={temp} onClose={() => setTemp(null)} />
    </div>
  );
}

const summariseSchedule = (s = []) => {
  if (!s.length) return 'No schedule';
  const days = [...new Set(s.map((b) => b.weekday))].sort();
  return `${days.map((d) => WEEKDAYS[d].slice(0, 3)).join(', ')}`;
};

function DoctorForm({ doctor, deps, onClose, onCreated }) {
  const isNew = !doctor.id;
  const f = useForm({
    fullName: doctor.fullName ?? '', username: '', email: doctor.email ?? '', phone: doctor.phone ?? '', doctorCode: doctor.doctorCode ?? '', specialization: doctor.specialization ?? '', qualification: doctor.qualification ?? '',
    licenseNumber: doctor.licenseNumber ?? '', departmentId: doctor.departmentId ?? '', consultationFee: doctor.consultationFee ?? '', slotMinutes: doctor.slotMinutes ?? 15, isActive: doctor.isActive ?? true,
  });
  const [blocks, setBlocks] = useState(doctor.schedules ?? [{ weekday: 1, startTime: '09:00', endTime: '13:00' }]);
  const [scheduleError, setScheduleError] = useState(null);
  const save = useAction(async (v) => {
    if (isNew) return post('/doctors', { ...v, schedules: blocks });
    const { username, ...rest } = v;
    const r = await patch(`/doctors/${doctor.id}`, rest);
    await put(`/doctors/${doctor.id}/schedules`, { schedules: blocks });
    return r;
  }, {
    success: isNew ? 'Doctor added' : 'Doctor updated', invalidate: ['doctors', 'users'],
    onError: (e) => { f.fromError(e); setScheduleError(e.fields?.schedules ?? null); return Boolean(e.fields); },
    onSuccess: (r) => { if (isNew) onCreated(r, f.values.fullName); onClose(); },
  });
  const setBlock = (i, k, v) => setBlocks(blocks.map((b, j) => (j === i ? { ...b, [k]: k === 'weekday' ? Number(v) : v } : b)));
  return (
    <Modal open onClose={onClose} width="max-w-3xl" title={isNew ? 'Add doctor' : `Edit ${doctor.fullName}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="doctor-form" loading={save.isPending}>{isNew ? 'Add doctor' : 'Save changes'}</Button></>}>
      <form id="doctor-form" onSubmit={(e) => { e.preventDefault(); save.mutate(f.values); }} noValidate>
        <div className="grid gap-4 sm:grid-cols-3">
          <Input label="Full name" required {...f.bind('fullName')} />
          {isNew && <Input label="Username" required {...f.bind('username')} />}
          <Input label="Email" type="email" required {...f.bind('email')} />
          <Input label="Phone" {...f.bind('phone')} />
          <Input label="Doctor ID" required hint="Unique, e.g. DOC-007" {...f.bind('doctorCode')} />
          <Input label="Specialization" required {...f.bind('specialization')} />
          <Input label="Qualification" {...f.bind('qualification')} />
          <Input label="License number" required {...f.bind('licenseNumber')} />
          <Select label="Department" required placeholder="Choose" options={deps.filter((d) => d.isActive).map((d) => ({ value: d.id, label: d.name }))} {...f.bind('departmentId')} />
          <Input label="Consultation fee" type="number" min="0" step="50" required {...f.bind('consultationFee')} />
          <Input label="Slot length (minutes)" type="number" min="5" max="120" required {...f.bind('slotMinutes')} />
          {!isNew && <Checkbox className="self-end pb-2" label="Accepting appointments" {...f.bind('isActive', { type: 'checkbox' })} />}
        </div>
        <fieldset className="mt-5">
          <legend className="font-sign text-lg font-semibold">Weekly availability</legend>
          <div className="mt-2 space-y-2">
            {blocks.map((b, i) => (
              <div key={i} className="flex flex-wrap items-end gap-2">
                <select className="field-input w-40" value={b.weekday} onChange={(e) => setBlock(i, 'weekday', e.target.value)} aria-label="Day">{WEEKDAYS.map((d, k) => <option key={d} value={k}>{d}</option>)}</select>
                <input type="time" className="field-input w-32" value={b.startTime} onChange={(e) => setBlock(i, 'startTime', e.target.value)} aria-label="From" />
                <span className="pb-2 text-sm text-muted">to</span>
                <input type="time" className="field-input w-32" value={b.endTime} onChange={(e) => setBlock(i, 'endTime', e.target.value)} aria-label="To" />
                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setBlocks(blocks.filter((_, j) => j !== i))} aria-label="Remove block" />
              </div>
            ))}
          </div>
          {scheduleError && <p className="mt-1 text-xs font-semibold text-alert">{scheduleError}</p>}
          <Button size="sm" variant="quiet" icon={Plus} className="mt-2" onClick={() => setBlocks([...blocks, { weekday: 1, startTime: '14:00', endTime: '17:00' }])}>Add time block</Button>
        </fieldset>
      </form>
    </Modal>
  );
}

// ----------------------------------------------------------------- departments (UC-09)
export function DepartmentsPage() {
  const q = useDepartments();
  const [editing, setEditing] = useState(null);
  const confirm = useConfirm();
  const remove = useAction((d) => del(`/departments/${d.id}`), { success: 'Department deleted', invalidate: ['departments'] });
  return (
    <div>
      <PageHeader way="admin" title="Departments" actions={<Button icon={Plus} onClick={() => setEditing({})}>Add department</Button>} />
      <Panel bodyClass="">
        <QueryState query={q}>
          {(r) => (
            <Table rows={r.data} empty={<EmptyState title="No departments yet" action={<Button onClick={() => setEditing({})}>Add the first department</Button>} />} columns={[
              { header: 'Name', render: (d) => <><p className="font-semibold">{d.name}</p><p className="text-xs text-muted">{d.description}</p></> },
              { header: 'Code', key: 'code' },
              { header: 'Location', key: 'location' },
              { header: 'Doctors', key: 'doctorCount' },
              { header: 'Staff', key: 'staffCount' },
              { header: 'Wards', key: 'wardCount' },
              { header: 'Status', render: (d) => <Status value={d.isActive ? 'active' : 'inactive'} /> },
              { header: '', className: 'text-right', render: (d) => <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(d)} aria-label={`Edit ${d.name}`} /><Button size="sm" variant="ghost" icon={Trash2} aria-label={`Delete ${d.name}`} onClick={async () => (await confirm({ title: `Delete ${d.name}?`, danger: true, confirmLabel: 'Delete', message: 'Departments that still have doctors, staff or wards cannot be deleted; mark them inactive instead.' })) && remove.mutate(d)} /></div> },
            ]} />
          )}
        </QueryState>
      </Panel>
      {editing && <DepartmentForm dep={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function DepartmentForm({ dep, onClose }) {
  const f = useForm({ name: dep.name ?? '', code: dep.code ?? '', description: dep.description ?? '', location: dep.location ?? '', phone: dep.phone ?? '', isActive: dep.isActive ?? true });
  const save = useAction((v) => (dep.id ? patch(`/departments/${dep.id}`, v) : post('/departments', v)), { success: 'Department saved', invalidate: ['departments'], onError: (e) => { f.fromError(e); return Boolean(e.fields); }, onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title={dep.id ? `Edit ${dep.name}` : 'Add department'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="dep-form" loading={save.isPending}>Save</Button></>}>
      <form id="dep-form" className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(f.values); }} noValidate>
        <Input label="Name" required {...f.bind('name')} />
        <Input label="Code" required {...f.bind('code')} />
        <Input label="Location" {...f.bind('location')} />
        <Input label="Phone" {...f.bind('phone')} />
        <Textarea label="Description" className="sm:col-span-2" {...f.bind('description')} />
        {dep.id && <Checkbox label="Active" {...f.bind('isActive', { type: 'checkbox' })} />}
      </form>
    </Modal>
  );
}

// ----------------------------------------------------------------- staffing levels (UC-10)
export function StaffingPage() {
  const q = useApi('/staff/staffing-levels');
  const deps = useDepartments();
  const roles = useApi('/users/roles');
  const f = useForm({ departmentId: '', roleId: '', requiredCount: '', notes: '' });
  const save = useAction((v) => put('/staff/staffing-levels', v), { success: 'Staffing level saved', invalidate: ['staff'], onError: (e) => { f.fromError(e); return Boolean(e.fields); }, onSuccess: () => f.reset() });
  const remove = useAction((id) => del(`/staff/staffing-levels/${id}`), { success: 'Removed', invalidate: ['staff'] });
  const edit = (l) => f.setValues({ departmentId: l.departmentId, roleId: l.roleId, requiredCount: l.requiredCount, notes: l.notes ?? '' });
  return (
    <div>
      <PageHeader way="admin" title="Staffing levels" subtitle="Required staff per department and role, compared with active staff. Review each level at least monthly." />
      <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
        <Panel bodyClass="">
          <QueryState query={q}>
            {(r) => (
              <Table rows={r.data} empty={<EmptyState title="No staffing levels defined" />} columns={[
                { header: 'Department', key: 'departmentName' },
                { header: 'Role', key: 'roleName' },
                { header: 'Required', render: (l) => <span className="font-semibold">{l.requiredCount}</span> },
                { header: 'Current', key: 'currentCount' },
                { header: 'Gap', render: (l) => (l.shortfall ? <Status value="short" tone="alert" label={`${l.shortfall} short`} /> : <Status value="ok" label="Met" />) },
                { header: 'Last reviewed', render: (l) => <span className={l.reviewDue ? 'font-semibold text-caution' : ''}>{date(l.reviewedAt)}{l.reviewDue ? ' (review due)' : ''}</span> },
                { header: '', className: 'text-right', render: (l) => <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" icon={Pencil} onClick={() => edit(l)} aria-label="Edit" /><Button size="sm" variant="ghost" icon={Trash2} onClick={() => remove.mutate(l.id)} aria-label="Remove" /></div> },
              ]} />
            )}
          </QueryState>
        </Panel>
        <Panel title="Set a staffing level">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(f.values); }} noValidate>
            <Select label="Department" required placeholder="Choose" options={(deps.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))} {...f.bind('departmentId')} />
            <Select label="Role" required placeholder="Choose" options={(roles.data?.roles ?? []).filter((r) => r.isStaff).map((r) => ({ value: r.id, label: r.name }))} {...f.bind('roleId')} />
            <Input label="Required staff" type="number" min="1" required {...f.bind('requiredCount')} />
            <Textarea label="Notes" rows={2} {...f.bind('notes')} />
            <Button type="submit" loading={save.isPending}>Save level</Button>
          </form>
        </Panel>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- staff list (UC-11)
export function StaffListPage({ fixedRole = '' } = {}) {
  const deps = useDepartments();
  const [f, setF] = useState({ search: '', role: fixedRole, departmentId: '', sort: 'name', dir: 'asc', page: 1 });
  const q = useApi(`/staff${qs({ ...f, pageSize: 25 })}`);
  const sortBy = (sort) => setF({ ...f, sort, dir: f.sort === sort && f.dir === 'asc' ? 'desc' : 'asc', page: 1 });
  const head = (label, key) => <button className="font-semibold hover:text-ink" onClick={() => sortBy(key)} aria-label={`Sort by ${label}`}>{label}{f.sort === key ? (f.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>;
  return (
    <div>
      <PageHeader way="admin" title={fixedRole === 'nurse' ? 'Nurse roster' : 'Staff list'} subtitle={fixedRole === 'nurse' ? 'Nurses assigned to departments, their status and joining details.' : 'All staff with their roles and departments.'} />
      <Panel bodyClass="">
        <div className="flex flex-wrap gap-3 border-b border-rule p-3">
          <input className="field-input max-w-xs" placeholder="Search name, employee code" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value, page: 1 })} aria-label="Search staff" />
          {!fixedRole && <select className="field-input w-48" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value, page: 1 })} aria-label="Role"><option value="">All roles</option>{Object.entries(ROLE_LABEL).filter(([k]) => k !== 'patient').map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}
          <select className="field-input w-56" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value, page: 1 })} aria-label="Department"><option value="">All departments</option>{(deps.data?.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        </div>
        <QueryState query={q}>
          {(r) => (
            <>
              <Table rows={r.data} empty={<EmptyState title="No staff records are available" >Try clearing the filters.</EmptyState>} columns={[
                { header: head('Name', 'name'), key: 'name', render: (s) => <><p className="font-semibold">{s.fullName}</p><p className="text-xs text-muted">{s.employeeCode}</p></> },
                { header: head('Role', 'role'), key: 'role', render: (s) => s.roleName },
                { header: head('Department', 'department'), key: 'dep', render: (s) => s.departmentName ?? '—' },
                { header: 'Designation', key: 'designation' },
                { header: 'Contact', key: 'contact', render: (s) => <span className="text-xs">{s.email}<br />{s.phone}</span> },
                { header: head('Joined', 'joined'), key: 'joined', render: (s) => date(s.dateJoined) },
                { header: 'Status', key: 'status', render: (s) => <Status value={s.status} /> },
              ]} />
              <Pagination page={r.page} pageSize={r.pageSize} total={r.total} onChange={(page) => setF({ ...f, page })} />
            </>
          )}
        </QueryState>
      </Panel>
    </div>
  );
}

// ----------------------------------------------------------------- cancellation approvals
export function CancellationRequestsPage() {
  const [status, setStatus] = useState('pending');
  const q = useApi(`/appointments/cancellation-requests?status=${status}`);
  const [deciding, setDeciding] = useState(null);
  const [note, setNote] = useState('');
  const decide = useAction(({ id, decision }) => post(`/appointments/cancellation-requests/${id}/${decision}`, { note }), { success: (_, v) => (v.decision === 'approve' ? 'Cancellation approved' : 'Cancellation rejected'), invalidate: ['appointments', 'reports'], onSuccess: () => { setDeciding(null); setNote(''); } });
  return (
    <div>
      <PageHeader way="admin" title="Cancellation approvals" subtitle="Cancellations requested less than 1 hour before the appointment need admin approval." />
      <div className="mb-3 flex gap-2">{['pending', 'approved', 'rejected', 'all'].map((s) => <Button key={s} size="sm" variant={status === s ? 'primary' : 'secondary'} onClick={() => setStatus(s)}>{s[0].toUpperCase() + s.slice(1)}</Button>)}</div>
      <Panel bodyClass="">
        <QueryState query={q}>
          {(r) => (
            <Table rows={r.data} empty={<EmptyState title="No requests" >Nothing is waiting for approval.</EmptyState>} columns={[
              { header: 'Appointment', render: (x) => <><p className="font-semibold">{date(x.date)} at {time(x.startTime)}</p><p className="text-xs text-muted">{x.appointmentCode}</p></> },
              { header: 'Patient', render: (x) => <>{x.patientName}<span className="block text-xs text-muted">{x.patientCode}</span></> },
              { header: 'Doctor', key: 'doctorName' },
              { header: 'Reason', key: 'reason' },
              { header: 'Requested', render: (x) => <>{relative(x.createdAt)}<span className="block text-xs text-muted">by {x.requestedByName}</span></> },
              { header: 'Status', render: (x) => <Status value={x.status} /> },
              { header: '', className: 'text-right', render: (x) => x.status === 'pending' && <Button size="sm" onClick={() => setDeciding(x)}>Decide</Button> },
            ]} />
          )}
        </QueryState>
      </Panel>
      <Modal open={Boolean(deciding)} onClose={() => setDeciding(null)} title="Cancellation request" footer={<><Button variant="secondary" loading={decide.isPending} onClick={() => decide.mutate({ id: deciding.id, decision: 'reject' })}>Keep the appointment</Button><Button variant="danger" loading={decide.isPending} onClick={() => decide.mutate({ id: deciding.id, decision: 'approve' })}>Approve cancellation</Button></>}>
        {deciding && (
          <>
            <KeyValue items={[['Patient', deciding.patientName], ['Doctor', deciding.doctorName], ['When', `${date(deciding.date)} at ${time(deciding.startTime)}`], ['Reason', deciding.reason]]} />
            <Textarea className="mt-4" label="Note (optional)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            <Callout tone="info" className="mt-3">Approving frees the slot and offers it to the first patient on the waitlist.</Callout>
          </>
        )}
      </Modal>
    </div>
  );
}
