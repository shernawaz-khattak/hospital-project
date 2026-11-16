// Stock helpers shared by clinical (prescribing) and pharmacy (dispensing, alerts).
// Dispensable stock = quantity in active batches that have not expired.
import { db } from '../../db/knex.js';
import { todayStr } from '../../lib/dates.js';
import { notify } from '../../services/notifications.js';
import { publishToPermission } from '../../services/realtime.js';

export async function availableStock(medicineId, conn = db) {
  const r = await conn('medicine_batches').where({ medicine_id: medicineId, status: 'active' }).where('expiry_date', '>=', todayStr()).sum({ q: 'quantity' }).first();
  return Number(r.q ?? 0);
}

export async function stockMap(medicineIds, conn = db) {
  if (!medicineIds.length) return {};
  const rows = await conn('medicine_batches').whereIn('medicine_id', medicineIds).where({ status: 'active' }).where('expiry_date', '>=', todayStr()).groupBy('medicine_id').select('medicine_id', conn.raw('sum(quantity)::int as q'));
  const map = Object.fromEntries(medicineIds.map((id) => [id, 0]));
  for (const r of rows) map[r.medicine_id] = Number(r.q);
  return map;
}

/** UC-27 2-A: in-stock alternatives (same generic first, then same category). */
export async function alternativesFor(medicine, needed, conn = db) {
  const candidates = await conn('medicines').where({ is_active: true }).whereNot({ id: medicine.id })
    .where((w) => w.whereRaw('lower(generic_name) = lower(?)', [medicine.generic_name]).orWhere('category', medicine.category));
  const stock = await stockMap(candidates.map((c) => c.id), conn);
  return candidates
    .filter((c) => stock[c.id] >= Math.max(1, needed))
    .sort((a, b) => (b.generic_name.toLowerCase() === medicine.generic_name.toLowerCase()) - (a.generic_name.toLowerCase() === medicine.generic_name.toLowerCase()))
    .slice(0, 3)
    .map((c) => ({ id: c.id, name: c.name, genericName: c.generic_name, strength: c.strength, form: c.form, stock: stock[c.id], sameGeneric: c.generic_name.toLowerCase() === medicine.generic_name.toLowerCase() }));
}

/** FR-25 / UC-37: raise (once) or resolve the low-stock alert for a medicine. */
export async function evaluateLowStock(trx, medicineId) {
  const med = await trx('medicines').where({ id: medicineId }).first();
  const stock = await availableStock(medicineId, trx);
  const open = await trx('stock_alerts').where({ medicine_id: medicineId, alert_type: 'low_stock', status: 'open' }).first();
  if (stock <= med.reorder_level && med.is_active) {
    if (!open) {
      const message = `${med.name} ${med.strength} is at ${stock} unit(s), at or below the restock level of ${med.reorder_level}.`;
      await trx('stock_alerts').insert({ medicine_id: medicineId, alert_type: 'low_stock', message });
      await notify(trx, { permission: 'inventory.manage', priority: 'high', eventType: 'pharmacy.low_stock', title: 'Restock alert', message, link: `/pharmacy/medicines/${medicineId}`, entityType: 'medicine', entityId: medicineId });
    }
  } else if (open) {
    await trx('stock_alerts').where({ id: open.id }).update({ status: 'resolved', resolved_at: new Date() });
  }
  trx.afterCommit?.(() => publishToPermission(['inventory.view', 'inventory.manage'], 'inventory.changed', { medicineId }));
  return stock;
}
