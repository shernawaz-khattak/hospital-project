import { Router } from 'express';
import { db } from '../../db/knex.js';
import { requirePermission } from '../../middleware/auth.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../services/audit.js';

const router = Router();
const SHIFTS = ['morning', 'evening', 'night', 'off'];

export function validMonth(month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) return false;
  const [year, number] = month.split('-').map(Number);
  return year >= 2000 && year <= 9998 && number >= 1 && number <= 12;
}

function monthBounds(month) {
  const [year, number] = month.split('-').map(Number);
  const end = new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 10);
  return [`${month}-01`, end];
}

export function validateRosterEntries(entries, month, activeNurseIds = null) {
  if (!Array.isArray(entries)) throw new AppError(422, 'Roster entries are required.');
  const validEntries = [];
  for (const entry of entries) {
    if (!entry?.staffId || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || !SHIFTS.includes(entry.shift)) {
      throw new AppError(422, 'Each roster entry must include a nurse, date and valid shift.');
    }
    if (!entry.date.startsWith(month)) throw new AppError(422, 'Roster dates must belong to the selected month.');
    validEntries.push({ staff_id: entry.staffId, roster_date: entry.date, shift: entry.shift });
  }
  const entryKeys = validEntries.map((entry) => `${entry.staff_id}:${entry.roster_date}`);
  if (new Set(entryKeys).size !== entryKeys.length) {
    throw new AppError(422, 'Each nurse can have only one shift per date.', { fields: { entries: 'Each nurse can have only one shift per date.' } });
  }
  if (activeNurseIds) {
    const nurseIdSet = new Set(activeNurseIds.map(Number));
    if (validEntries.some((entry) => !nurseIdSet.has(Number(entry.staff_id)))) {
      throw new AppError(422, 'Roster entries can only use active nurses.', { fields: { staffId: 'Roster entries can only use active nurses.' } });
    }
  }
  return validEntries;
}

router.get('/roster', requirePermission('nursing.roster.view'), async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  if (!validMonth(month)) throw new AppError(422, 'Select a valid month.');
  const nurses = await db('staff as st')
    .join('users as u', 'u.id', 'st.user_id')
    .join('roles as r', 'r.id', 'u.role_id')
    .where({ 'r.code': 'nurse', 'u.status': 'active' })
    .select('st.id', 'u.full_name as fullName')
    .orderBy('u.full_name');
  if (!nurses.length) return res.json({ month, nurses: [], roster: [] });
  const [start, end] = monthBounds(month);
  const roster = await db('nurse_rosters')
    .whereIn('staff_id', nurses.map((n) => n.id))
    .where('roster_date', '>=', start)
    .where('roster_date', '<', end)
    .select('staff_id as staffId', 'roster_date as date', 'shift');
  res.json({
    month,
    nurses: nurses.map((n) => ({ id: n.id, fullName: n.fullName })),
    roster: roster.map((r) => ({ ...r, date: String(r.date).slice(0, 10) })),
  });
});

router.put('/roster', requirePermission('nursing.roster.manage'), async (req, res) => {
  const month = req.body?.month;
  const entries = req.body?.entries;
  if (!validMonth(month)) throw new AppError(422, 'Select a valid month.', { fields: { month: 'Select a valid month.' } });
  const validEntries = validateRosterEntries(entries, month);

  await db.transaction(async (trx) => {
    const nurseStaffIds = await trx('staff as st')
      .join('users as u', 'u.id', 'st.user_id')
      .join('roles as r', 'r.id', 'u.role_id')
      .where({ 'r.code': 'nurse', 'u.status': 'active' })
      .pluck('st.id');
    validateRosterEntries(entries, month, nurseStaffIds.map(Number));
    const [start, end] = monthBounds(month);
    await trx('nurse_rosters')
      .where('roster_date', '>=', start)
      .where('roster_date', '<', end)
      .whereIn('staff_id', await trx('staff as st').join('users as u', 'u.id', 'st.user_id').join('roles as r', 'r.id', 'u.role_id').where('r.code', 'nurse').pluck('st.id'))
      .del();
    if (validEntries.length) await trx('nurse_rosters').insert(validEntries);
  });
  await audit(req, { action: 'nurse.roster.update', entityType: 'nurse_roster', details: { month, entries: validEntries.length } });
  res.json({ ok: true, month, entries: validEntries.length });
});

export default router;
