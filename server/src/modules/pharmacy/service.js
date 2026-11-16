// Pharmacy (SRS FR-23..FR-26; UC-34 Verify, UC-35 Issue, UC-36 Inventory, UC-37 Restock alerts,
// UC-38 Expiry). Stock lives in batches; dispensing takes from the earliest-expiring
// non-expired batch first (FEFO) under row locks, so concurrent dispensing cannot oversell.
import { db } from '../../db/knex.js';
import { transaction } from '../../db/tx.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { addDays, ageFrom, todayStr } from '../../lib/dates.js';
import { decrypt } from '../../lib/crypto.js';
import { audit, systemCtx } from '../../services/audit.js';
import { notify } from '../../services/notifications.js';
import { publishToPermission } from '../../services/realtime.js';
import { availableStock, evaluateLowStock, stockMap, alternativesFor } from './stock.js';
import { validateDispensePlan } from '../clinical/journeyIntegrity.js';

export const VERIFY_SLA_MINUTES = 15; // UC-34
export const EXPIRY_WARNING_DAYS = 30; // UC-38

// ----------------------------------------------------------------- medicines & batches
export async function listMedicines({ search, category, filter, includeInactive }) {
  const today = todayStr();
  const soon = addDays(today, EXPIRY_WARNING_DAYS);
  const q = db('medicines as m').select(
    'm.*',
    db.raw(`COALESCE((SELECT sum(quantity) FROM medicine_batches b WHERE b.medicine_id = m.id AND b.status = 'active' AND b.expiry_date >= ?), 0)::int AS stock`, [today]),
    db.raw(`COALESCE((SELECT sum(quantity) FROM medicine_batches b WHERE b.medicine_id = m.id AND b.status = 'active' AND b.expiry_date < ?), 0)::int AS expired_stock`, [today]),
    db.raw(`(SELECT min(expiry_date) FROM medicine_batches b WHERE b.medicine_id = m.id AND b.status = 'active' AND b.quantity > 0 AND b.expiry_date >= ?) AS next_expiry`, [today]),
  ).orderBy('m.name');
  if (!includeInactive) q.where('m.is_active', true);
  if (search) q.where((w) => w.whereILike('m.name', `%${search}%`).orWhereILike('m.generic_name', `%${search}%`));
  if (category) q.where('m.category', category);
  let rows = (await q).map((m) => ({
    id: m.id, name: m.name, genericName: m.generic_name, form: m.form, strength: m.strength, category: m.category, unitPrice: m.unit_price, reorderLevel: m.reorder_level, isActive: m.is_active,
    stock: m.stock, expiredStock: m.expired_stock, nextExpiry: m.next_expiry, lowStock: m.stock <= m.reorder_level, outOfStock: m.stock === 0, expiringSoon: Boolean(m.next_expiry && m.next_expiry <= soon),
  }));
  if (filter === 'low') rows = rows.filter((r) => r.lowStock);
  if (filter === 'out') rows = rows.filter((r) => r.outOfStock);
  if (filter === 'expiring') rows = rows.filter((r) => r.expiringSoon || r.expiredStock > 0);
  return rows;
}

export async function medicineDetail(id) {
  const [m] = await listMedicines({ includeInactive: true }).then((all) => all.filter((x) => x.id === id));
  if (!m) throw notFound('Medicine not found.');
  const batches = await db('medicine_batches').where({ medicine_id: id }).orderBy([{ column: 'status' }, { column: 'expiry_date' }]);
  const txns = await db('inventory_transactions as t').leftJoin('medicine_batches as b', 'b.id', 't.batch_id').leftJoin('users as u', 'u.id', 't.performed_by')
    .where('t.medicine_id', id).orderBy('t.created_at', 'desc').limit(100).select('t.*', 'b.batch_number', 'u.full_name as by_name');
  const today = todayStr();
  return {
    ...m,
    batches: batches.map((b) => ({ id: b.id, batchNumber: b.batch_number, quantity: b.quantity, expiryDate: b.expiry_date, supplier: b.supplier, costPrice: b.cost_price, status: b.status, receivedAt: b.received_at, expiryState: expiryState(b.expiry_date, today) })),
    transactions: txns.map((t) => ({ id: t.id, type: t.txn_type, quantityChange: t.quantity_change, stockAfter: t.stock_after, batchNumber: t.batch_number, reason: t.reason, referenceType: t.reference_type, referenceId: t.reference_id, byName: t.by_name, at: t.created_at })),
  };
}

const expiryState = (date, today = todayStr()) => (date < today ? 'expired' : date <= addDays(today, EXPIRY_WARNING_DAYS) ? 'expiring' : 'ok');

export async function createMedicine(req, b) {
  const [m] = await db('medicines').insert({ name: b.name, generic_name: b.genericName, form: b.form, strength: b.strength, category: b.category, unit_price: b.unitPrice, reorder_level: b.reorderLevel }).returning('*');
  await audit(req, { action: 'inventory.medicine_create', entityType: 'medicine', entityId: m.id, details: { name: m.name } });
  return m;
}

export async function updateMedicine(req, id, b) {
  const map = { name: 'name', genericName: 'generic_name', form: 'form', strength: 'strength', category: 'category', unitPrice: 'unit_price', isActive: 'is_active' };
  const patch = { updated_at: new Date() };
  for (const [k, c] of Object.entries(map)) if (b[k] !== undefined) patch[c] = b[k];
  const [m] = await db('medicines').where({ id }).update(patch).returning('*');
  if (!m) throw notFound('Medicine not found.');
  await audit(req, { action: 'inventory.medicine_update', entityType: 'medicine', entityId: id, details: { fields: Object.keys(b) } });
  return m;
}

/** UC-37: set the minimum stock level; alert immediately if already at/below it. */
export async function setReorderLevel(req, id, level) {
  await transaction(async (trx) => {
    const m = await trx('medicines').where({ id }).first();
    if (!m) throw notFound('Medicine not found.');
    await trx('medicines').where({ id }).update({ reorder_level: level, updated_at: new Date() });
    await audit(req, { action: 'inventory.restock_alert_set', entityType: 'medicine', entityId: id, details: { from: m.reorder_level, to: level } }, trx);
    await evaluateLowStock(trx, id);
  });
}

async function stockTxn(trx, req, { medicineId, batchId, type, change, reason, refType = null, refId = null }) {
  const after = await availableStock(medicineId, trx);
  await trx('inventory_transactions').insert({ medicine_id: medicineId, batch_id: batchId, txn_type: type, quantity_change: change, stock_after: after, reason, reference_type: refType, reference_id: refId, performed_by: req.user?.id ?? null });
}

export async function receiveBatch(req, medicineId, b) {
  if (b.expiryDate <= todayStr()) throw new AppError(422, 'Expired stock cannot be received.', { fields: { expiryDate: 'Expiry date must be in the future.' } });
  return transaction(async (trx) => {
    const m = await trx('medicines').where({ id: medicineId }).first();
    if (!m) throw notFound('Medicine not found.');
    const [batch] = await trx('medicine_batches').insert({ medicine_id: medicineId, batch_number: b.batchNumber, quantity: b.quantity, expiry_date: b.expiryDate, supplier: b.supplier, cost_price: b.costPrice, received_by: req.user.id }).returning('*');
    await stockTxn(trx, req, { medicineId, batchId: batch.id, type: 'receive', change: b.quantity, reason: b.supplier ? `Received from ${b.supplier}` : 'Stock received' });
    await audit(req, { action: 'inventory.receive', entityType: 'medicine', entityId: medicineId, details: { batch: b.batchNumber, quantity: b.quantity } }, trx);
    await evaluateLowStock(trx, medicineId);
    return batch;
  });
}

/** Manual stock correction. UC-36 1-A: stock can never become negative. */
export async function adjustBatch(req, batchId, { quantityChange, reason }) {
  return transaction(async (trx) => {
    const b = await trx('medicine_batches').where({ id: batchId }).forUpdate().first();
    if (!b) throw notFound('Batch not found.');
    if (b.status !== 'active') throw conflict('This batch has been removed from inventory.');
    if (b.quantity + quantityChange < 0) throw new AppError(422, `Stock cannot go below zero. This batch has ${b.quantity} unit(s).`, { fields: { quantityChange: 'Resulting stock would be negative.' } });
    await trx('medicine_batches').where({ id: batchId }).update({ quantity: b.quantity + quantityChange });
    await stockTxn(trx, req, { medicineId: b.medicine_id, batchId, type: 'adjust', change: quantityChange, reason });
    await audit(req, { action: 'inventory.adjust', entityType: 'medicine', entityId: b.medicine_id, details: { batch: b.batch_number, change: quantityChange, reason } }, trx);
    await evaluateLowStock(trx, b.medicine_id);
  });
}

// ----------------------------------------------------------------- expiry (UC-38)
export async function expiryTracker() {
  const today = todayStr();
  const rows = await db('medicine_batches as b').join('medicines as m', 'm.id', 'b.medicine_id')
    .where('b.status', 'active').where('b.quantity', '>', 0).where('b.expiry_date', '<=', addDays(today, EXPIRY_WARNING_DAYS))
    .orderBy('b.expiry_date').select('b.*', 'm.name', 'm.strength', 'm.form');
  const data = rows.map((b) => ({
    batchId: b.id, medicineId: b.medicine_id, medicine: `${b.name} ${b.strength}`, form: b.form, batchNumber: b.batch_number, quantity: b.quantity, expiryDate: b.expiry_date,
    state: expiryState(b.expiry_date, today), daysLeft: Math.round((new Date(b.expiry_date) - new Date(today)) / 86400000),
  }));
  return { data, allValid: data.length === 0, message: data.length === 0 ? 'All medicines are within their valid dates.' : null };
}

export async function removeExpiredBatch(req, batchId, reason) {
  return transaction(async (trx) => {
    const b = await trx('medicine_batches').where({ id: batchId }).forUpdate().first();
    if (!b) throw notFound('Batch not found.');
    if (b.status !== 'active') throw conflict('This batch has already been removed.');
    if (b.expiry_date >= todayStr()) throw conflict('Only expired batches can be removed this way. Use a stock adjustment for other corrections.');
    await trx('medicine_batches').where({ id: batchId }).update({ quantity: 0, status: 'removed', removed_at: new Date() });
    if (b.quantity > 0) await stockTxn(trx, req, { medicineId: b.medicine_id, batchId, type: 'expired_removal', change: -b.quantity, reason: reason || 'Expired stock removed' });
    await trx('stock_alerts').where({ batch_id: batchId, status: 'open' }).update({ status: 'resolved', resolved_at: new Date() });
    await audit(req, { action: 'inventory.expired_removal', entityType: 'medicine', entityId: b.medicine_id, details: { batch: b.batch_number, quantity: b.quantity } }, trx);
    await evaluateLowStock(trx, b.medicine_id);
  });
}

/** Daily job: flag batches expiring within 30 days and expired batches; notify pharmacists. */
export async function scanExpiry() {
  const today = todayStr();
  const rows = await db('medicine_batches as b').join('medicines as m', 'm.id', 'b.medicine_id')
    .where('b.status', 'active').where('b.quantity', '>', 0).where('b.expiry_date', '<=', addDays(today, EXPIRY_WARNING_DAYS)).select('b.*', 'm.name', 'm.strength');
  let created = 0;
  await transaction(async (trx) => {
    for (const b of rows) {
      const type = b.expiry_date < today ? 'expired' : 'near_expiry';
      if (type === 'expired') await trx('stock_alerts').where({ batch_id: b.id, alert_type: 'near_expiry', status: 'open' }).update({ status: 'resolved', resolved_at: new Date() });
      const inserted = await trx('stock_alerts')
        .insert({ medicine_id: b.medicine_id, batch_id: b.id, alert_type: type, message: `${b.name} ${b.strength} batch ${b.batch_number} (${b.quantity} units) ${type === 'expired' ? 'expired on' : 'expires on'} ${b.expiry_date}.` })
        .onConflict(db.raw("(medicine_id, alert_type, COALESCE(batch_id, 0)) WHERE status = 'open'")).ignore().returning('id');
      created += inserted.length;
    }
    if (created) {
      await notify(trx, { permission: 'inventory.manage', priority: 'high', eventType: 'pharmacy.expiry', title: 'Medicine expiry alert', message: `${created} batch(es) are expired or expire within ${EXPIRY_WARNING_DAYS} days. Review the expiry tracker.`, link: '/pharmacy/expiry' });
      await audit(systemCtx, { action: 'inventory.expiry_scan', details: { flagged: created } }, trx);
    }
  });
  return created;
}

export async function listAlerts(status = 'open') {
  const rows = await db('stock_alerts as a').join('medicines as m', 'm.id', 'a.medicine_id').leftJoin('medicine_batches as b', 'b.id', 'a.batch_id')
    .modify((q) => status !== 'all' && q.where('a.status', status)).orderBy('a.created_at', 'desc').limit(200)
    .select('a.*', 'm.name', 'm.strength', 'b.batch_number');
  return rows.map((a) => ({ id: a.id, type: a.alert_type, status: a.status, message: a.message, medicineId: a.medicine_id, medicine: `${a.name} ${a.strength}`, batchNumber: a.batch_number, createdAt: a.created_at, resolvedAt: a.resolved_at }));
}

export async function resolveAlert(req, id) {
  const n = await db('stock_alerts').where({ id, status: 'open' }).update({ status: 'resolved', resolved_at: new Date() });
  if (!n) throw notFound('Open alert not found.');
  await audit(req, { action: 'inventory.alert_resolved', entityType: 'stock_alert', entityId: id });
}

// ----------------------------------------------------------------- prescriptions queue
const rxSelect = ['p.*', 'pt.patient_code', 'pt.first_name', 'pt.last_name', 'pt.date_of_birth', 'pt.gender', 'pt.allergies_enc', 'u.full_name as doctor_name', 'u.id as doctor_user_id', 'd.specialization', 'vu.full_name as verified_by_name', 'fu.full_name as flagged_by_name'];
const rxQuery = (conn = db) =>
  conn('prescriptions as p').join('patients as pt', 'pt.id', 'p.patient_id').join('doctors as d', 'd.id', 'p.doctor_id').join('staff as s', 's.id', 'd.staff_id').join('users as u', 'u.id', 's.user_id')
    .leftJoin('users as vu', 'vu.id', 'p.verified_by').leftJoin('users as fu', 'fu.id', 'p.flagged_by');

function rxDto(p, items = null, withAllergies = false) {
  const waiting = Math.round((Date.now() - new Date(p.sent_to_pharmacy_at).getTime()) / 60000);
  return {
    id: p.id, prescriptionCode: p.prescription_code, status: p.status, notes: p.notes, createdAt: p.created_at, sentToPharmacyAt: p.sent_to_pharmacy_at, waitingMinutes: waiting,
    verificationOverdue: p.status === 'pending' && waiting > VERIFY_SLA_MINUTES, verifiedAt: p.verified_at, verifiedByName: p.verified_by_name,
    flagReason: p.flag_reason, flaggedAt: p.flagged_at, flaggedByName: p.flagged_by_name, stockWarningAcknowledged: p.stock_warning_acknowledged,
    patient: { id: p.patient_id, patientCode: p.patient_code, fullName: `${p.first_name} ${p.last_name}`, age: ageFrom(p.date_of_birth), gender: p.gender, ...(withAllergies ? { allergies: decrypt(p.allergies_enc) } : {}) },
    doctor: { id: p.doctor_id, fullName: p.doctor_name, specialization: p.specialization },
    ...(items ? { items } : {}),
  };
}

export async function listPrescriptions({ status }) {
  const q = rxQuery().select(rxSelect).limit(300);
  if (status === 'queue' || !status) q.whereIn('p.status', ['pending', 'verified', 'partially_dispensed']);
  else if (status !== 'all') q.whereIn('p.status', status.split(','));
  q.orderByRaw("CASE p.status WHEN 'pending' THEN 0 WHEN 'verified' THEN 1 WHEN 'partially_dispensed' THEN 2 ELSE 3 END").orderBy('p.sent_to_pharmacy_at', status === 'dispensed' ? 'desc' : 'asc');
  return (await q).map((p) => rxDto(p));
}

export async function prescriptionDetail(id, conn = db) {
  const p = await rxQuery(conn).where('p.id', id).first(rxSelect);
  if (!p) throw notFound('Prescription not found.');
  const items = await conn('prescription_items as i').join('medicines as m', 'm.id', 'i.medicine_id').where('i.prescription_id', id).orderBy('i.id')
    .select('i.*', 'm.name', 'm.generic_name', 'm.strength', 'm.form', 'm.unit_price', 'm.category', conn.raw('(SELECT COALESCE(sum(quantity),0)::int FROM dispensing_items di WHERE di.prescription_item_id = i.id) AS dispensed'));
  const stock = await stockMap(items.map((i) => i.medicine_id), conn);
  const dispensings = await conn('dispensings as ds').join('users as u', 'u.id', 'ds.dispensed_by').where('ds.prescription_id', id).orderBy('ds.dispensed_at').select('ds.*', 'u.full_name as by_name');
  return {
    ...rxDto(p, null, true),
    items: items.map((i) => ({
      id: i.id, medicineId: i.medicine_id, name: i.name, genericName: i.generic_name, strength: i.strength, form: i.form, unitPrice: i.unit_price, dosage: i.dosage, frequency: i.frequency,
      durationDays: i.duration_days, quantity: i.quantity, instructions: i.instructions, dispensed: i.dispensed, remaining: i.quantity - i.dispensed, stock: stock[i.medicine_id], inStock: stock[i.medicine_id] >= i.quantity - i.dispensed,
    })),
    dispensings: dispensings.map((d) => ({ id: d.id, at: d.dispensed_at, byName: d.by_name, notes: d.notes })),
  };
}

export async function verifyPrescription(req, id) {
  await transaction(async (trx) => {
    const p = await trx('prescriptions').where({ id }).forUpdate().first();
    if (!p) throw notFound('Prescription not found.');
    if (p.status !== 'pending') throw conflict(`This prescription is ${p.status} and cannot be verified.`);
    await trx('prescriptions').where({ id }).update({ status: 'verified', verified_by: req.user.id, verified_at: new Date(), updated_at: new Date() });
    const minutes = Math.round((Date.now() - new Date(p.sent_to_pharmacy_at)) / 60000);
    await audit(req, { action: 'prescription.verify', entityType: 'prescription', entityId: id, details: { minutesToVerify: minutes, withinSla: minutes <= VERIFY_SLA_MINUTES } }, trx);
    trx.afterCommit(() => publishToPermission(['pharmacy.verify', 'pharmacy.dispense'], 'prescriptions.changed', {}));
  });
}

/** UC-34 2-A: flag a prescription and notify the doctor. */
export async function flagPrescription(req, id, reason) {
  await transaction(async (trx) => {
    const p = await rxQuery(trx).where('p.id', id).forUpdate('p').first(rxSelect);
    if (!p) throw notFound('Prescription not found.');
    if (!['pending', 'verified'].includes(p.status)) throw conflict(`This prescription is ${p.status} and cannot be flagged.`);
    await trx('prescriptions').where({ id }).update({ status: 'flagged', flag_reason: reason, flagged_by: req.user.id, flagged_at: new Date(), updated_at: new Date() });
    await audit(req, { action: 'prescription.flag', entityType: 'prescription', entityId: id, details: { reason } }, trx);
    await notify(trx, { userIds: [p.doctor_user_id], priority: 'high', eventType: 'prescription.flagged', title: 'Prescription flagged by pharmacy', message: `${p.prescription_code} for ${p.first_name} ${p.last_name} was flagged: ${reason}`, link: '/doctor/flagged', entityType: 'prescription', entityId: id });
    trx.afterCommit(() => publishToPermission(['pharmacy.verify', 'pharmacy.dispense'], 'prescriptions.changed', {}));
  });
}

/** UC-35: issue medicines, update inventory automatically, record quantity and date. */
export async function dispense(req, id, { items, notes }) {
  const result = await transaction(async (trx) => {
    const p = await rxQuery(trx).where('p.id', id).forUpdate('p').first(rxSelect);
    if (!p) throw notFound('Prescription not found.');
    if (!['verified', 'partially_dispensed'].includes(p.status)) throw conflict(p.status === 'pending' ? 'Verify the prescription before dispensing.' : `This prescription is ${p.status.replace('_', ' ')}.`);
    const rxItems = await trx('prescription_items as i').join('medicines as m', 'm.id', 'i.medicine_id').where('i.prescription_id', id)
      .select('i.*', 'm.name', 'm.strength', 'm.unit_price', 'm.generic_name', 'm.category', trx.raw('(SELECT COALESCE(sum(quantity),0)::int FROM dispensing_items di WHERE di.prescription_item_id = i.id) AS dispensed'));
    let requested;
    try {
      requested = validateDispensePlan(rxItems, items);
    } catch (error) {
      throw new AppError(422, error.message, { fields: { items: error.message } });
    }

    const shortages = [];
    const plan = [];
    for (const it of requested) {
      const rxItem = rxItems.find((r) => r.id === it.prescriptionItemId);
      if (!rxItem) throw new AppError(422, 'An item does not belong to this prescription.', { fields: { items: 'Invalid item.' } });
      const remaining = rxItem.quantity - rxItem.dispensed;
      if (it.quantity > remaining) throw new AppError(422, `${rxItem.name}: only ${remaining} unit(s) remain to be issued.`, { fields: { [`item-${rxItem.id}`]: `Maximum ${remaining}.` } });
      // FEFO allocation from non-expired batches, locked for this transaction.
      const batches = await trx('medicine_batches').where({ medicine_id: rxItem.medicine_id, status: 'active' }).where('expiry_date', '>=', todayStr()).where('quantity', '>', 0).orderBy([{ column: 'expiry_date' }, { column: 'id' }]).forUpdate();
      let need = it.quantity;
      const allocations = [];
      for (const b of batches) {
        if (need <= 0) break;
        const take = Math.min(b.quantity, need);
        allocations.push({ batch: b, take });
        need -= take;
      }
      if (need > 0) {
        shortages.push({ prescriptionItemId: rxItem.id, medicineId: rxItem.medicine_id, medicine: `${rxItem.name} ${rxItem.strength}`, requested: it.quantity, available: it.quantity - need, alternatives: await alternativesFor({ id: rxItem.medicine_id, generic_name: rxItem.generic_name, category: rxItem.category }, it.quantity, trx) });
      }
      plan.push({ rxItem, allocations });
    }
    if (shortages.length) {
      // UC-35 2-A: out-of-stock alert; pharmacist is told to contact the doctor.
      await notify(db, { userIds: [req.user.id], priority: 'high', eventType: 'pharmacy.out_of_stock', title: 'Out of stock — contact the doctor', message: `${p.prescription_code}: ${shortages.map((s) => `${s.medicine} (needed ${s.requested}, available ${s.available})`).join('; ')}. Contact ${p.doctor_name} about alternatives.`, link: `/pharmacy/prescriptions/${id}`, entityType: 'prescription', entityId: id });
      throw conflict('Some medicines are out of stock. Issue the available items only, or contact the doctor about an alternative.', { code: 'OUT_OF_STOCK', details: { shortages, doctor: p.doctor_name } });
    }

    const [ds] = await trx('dispensings').insert({ prescription_id: id, dispensed_by: req.user.id, notes }).returning('*');
    const touched = new Set();
    for (const { rxItem, allocations } of plan) {
      for (const { batch, take } of allocations) {
        // Decrement in SQL (not from the value read earlier); the CHECK (quantity >= 0) is the final guard.
        await trx('medicine_batches').where({ id: batch.id }).decrement('quantity', take);
        await trx('dispensing_items').insert({ dispensing_id: ds.id, prescription_item_id: rxItem.id, medicine_id: rxItem.medicine_id, batch_id: batch.id, quantity: take, unit_price: rxItem.unit_price });
        await stockTxn(trx, req, { medicineId: rxItem.medicine_id, batchId: batch.id, type: 'dispense', change: -take, reason: `Dispensed for ${p.prescription_code}`, refType: 'prescription', refId: id });
      }
      touched.add(rxItem.medicine_id);
    }
    const left = await trx('prescription_items as i').where('i.prescription_id', id).select(trx.raw('i.quantity - (SELECT COALESCE(sum(quantity),0) FROM dispensing_items di WHERE di.prescription_item_id = i.id) AS remaining'));
    const status = left.every((r) => Number(r.remaining) === 0) ? 'dispensed' : 'partially_dispensed';
    await trx('prescriptions').where({ id }).update({ status, updated_at: new Date() });
    await audit(req, { action: 'pharmacy.dispense', entityType: 'prescription', entityId: id, details: { dispensingId: ds.id, items: plan.map((x) => ({ medicine: x.rxItem.name, quantity: x.allocations.reduce((s, a) => s + a.take, 0) })), status } }, trx);
    for (const mid of touched) await evaluateLowStock(trx, mid); // FR-25: automatic restock alerts
    trx.afterCommit(() => publishToPermission(['pharmacy.verify', 'pharmacy.dispense'], 'prescriptions.changed', {}));
    return { status };
  });
  return { ...result, prescription: await prescriptionDetail(id) };
}
