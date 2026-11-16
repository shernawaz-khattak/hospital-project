// Billing (SRS FR-27..FR-29; UC-39 Generate Bill, UC-40 Apply Insurance, UC-41 Record Payment,
// UC-42 Issue Receipt). Amounts are calculated server-side from recorded services only.
import { db } from '../../db/knex.js';
import { transaction } from '../../db/tx.js';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors.js';
import { nextCode } from '../../lib/codes.js';
import { fromCents, round2, toCents } from '../../lib/money.js';
import { todayStr } from '../../lib/dates.js';
import { env } from '../../config/env.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notifications.js';
import { publishToPermission } from '../../services/realtime.js';
import { getUnbilledServices } from './charges.js';
import { activeInsurance, toSummary } from '../patients/service.js';

const CATEGORY_ORDER = ['consultation', 'lab', 'medicine', 'room', 'other'];
const keyOf = (i) => `${i.sourceType}:${i.sourceId}${i.periodStart ? `:${i.periodStart}` : ''}`;

export async function billingPreview(patientId) {
  const patient = await db('patients').where({ id: patientId }).first();
  if (!patient) throw notFound('Patient not found.');
  const { items, warnings } = await getUnbilledServices(patientId);
  const subtotal = fromCents(items.reduce((s, i) => s + toCents(i.amount), 0));
  return {
    patient: toSummary(patient),
    items: items.map((i) => ({ ...i, key: keyOf(i) })),
    byCategory: CATEGORY_ORDER.map((c) => ({ category: c, amount: fromCents(items.filter((i) => i.category === c).reduce((s, i) => s + toCents(i.amount), 0)) })).filter((c) => c.amount > 0),
    subtotal, warnings, insurance: await activeInsurance(patientId),
  };
}

/** UC-39: generate an itemized bill from all (or selected) unbilled services plus any other charges. */
export async function generateBill(req, { patientId, excludeKeys = [], otherCharges = [], acknowledgeWarnings, notes }) {
  const bill = await transaction(async (trx) => {
    // Serialise billing per patient so the same service cannot be billed twice concurrently.
    const patient = await trx('patients').where({ id: patientId }).forUpdate().first();
    if (!patient) throw notFound('Patient not found.');
    const { items, warnings } = await getUnbilledServices(patientId, trx);
    if (items.some((i) => i.sourceType === 'admission' && excludeKeys.includes(keyOf(i)))) {
      throw new AppError(422, 'Room charges are billed in date order and cannot be left off a bill.', { code: 'ROOM_NOT_EXCLUDABLE' });
    }
    const chosen = items.filter((i) => !excludeKeys.includes(keyOf(i)));
    const others = otherCharges.map((o) => ({ category: 'other', description: o.description, quantity: o.quantity, unitPrice: o.unitPrice, amount: round2(o.quantity * o.unitPrice), sourceType: 'manual', sourceId: null, serviceDate: todayStr() }));
    const all = [...chosen, ...others];
    if (!all.length) throw conflict('There are no unbilled services for this patient.', { code: 'NOTHING_TO_BILL' });
    // UC-39 1-A: unrecorded services -> warn and ask the accountant to verify first.
    if (warnings.length && !acknowledgeWarnings) throw conflict('Some services are not recorded yet. Please verify before generating the bill.', { code: 'BILLING_WARNINGS', details: { warnings } });

    const subtotal = fromCents(all.reduce((s, i) => s + toCents(i.amount), 0));
    const admissionIds = [...new Set(chosen.filter((i) => i.sourceType === 'admission').map((i) => i.sourceId))];
    const [b] = await trx('bills').insert({
      bill_number: await nextCode(trx, 'bill_number_seq'), patient_id: patientId, admission_id: admissionIds.length === 1 ? admissionIds[0] : null,
      subtotal, insurance_amount: 0, total_payable: subtotal, amount_paid: 0, status: subtotal === 0 ? 'paid' : 'unpaid', notes, generated_by: req.user.id,
    }).returning('*');
    await trx('bill_items').insert(all.map((i) => ({
      bill_id: b.id, category: i.category, description: i.description, quantity: i.quantity, unit_price: i.unitPrice, amount: i.amount,
      source_type: i.sourceType, source_id: i.sourceId, period_start: i.periodStart ?? null, period_end: i.periodEnd ?? null, service_date: i.serviceDate,
    })));
    // Room charges are billed up to the last day included.
    for (const adId of admissionIds) {
      const last = chosen.filter((i) => i.sourceType === 'admission' && i.sourceId === adId).map((i) => i.periodEnd).sort().at(-1);
      await trx('admissions').where({ id: adId }).update({ room_billed_until: last });
    }
    await audit(req, { action: 'billing.bill_create', entityType: 'bill', entityId: b.id, details: { billNumber: b.bill_number, patientCode: patient.patient_code, subtotal, items: all.length, warningsAcknowledged: warnings.length } }, trx);
    await notify(trx, { patientId, email: true, eventType: 'billing.bill_generated', title: 'New bill', message: `Bill ${b.bill_number} for ${env.CURRENCY} ${subtotal.toFixed(2)} has been generated. You can view the itemized bill in the patient portal.`, link: '/portal/bills', entityType: 'bill', entityId: b.id });
    trx.afterCommit(() => publishToPermission(['billing.view', 'admissions.manage'], 'bills.changed', { patientId }));
    return b;
  });
  return billDetail(bill.id);
}

export async function listBills({ status, patientId, q, from, to, page = 1, pageSize = 30 }) {
  const query = db('bills as b').join('patients as p', 'p.id', 'b.patient_id');
  if (status === 'outstanding') query.where('b.balance', '>', 0);
  else if (status) query.where('b.status', status);
  if (patientId) query.where('b.patient_id', patientId);
  if (from) query.where('b.generated_at', '>=', `${from}T00:00:00`);
  if (to) query.where('b.generated_at', '<', db.raw("(?::date + interval '1 day')", [to]));
  if (q) query.where((w) => w.whereILike('b.bill_number', `%${q}%`).orWhereILike('p.patient_code', `%${q}%`).orWhereRaw("lower(p.first_name || ' ' || p.last_name) like lower(?)", [`%${q}%`]));
  const total = await query.clone().count({ n: '*' }).first();
  const rows = await query.select('b.*', 'p.patient_code', 'p.first_name', 'p.last_name').orderBy('b.generated_at', 'desc').offset((page - 1) * pageSize).limit(pageSize);
  return { data: rows.map(billSummary), total: Number(total.n), page, pageSize };
}

const billSummary = (b) => ({
  id: b.id, billNumber: b.bill_number, status: b.status, subtotal: b.subtotal, insuranceAmount: b.insurance_amount, totalPayable: b.total_payable, amountPaid: b.amount_paid, balance: b.balance,
  generatedAt: b.generated_at, patient: { id: b.patient_id, patientCode: b.patient_code, fullName: `${b.first_name} ${b.last_name}` },
});

export async function billDetail(id, conn = db) {
  const b = await conn('bills as b').join('patients as p', 'p.id', 'b.patient_id').join('users as u', 'u.id', 'b.generated_by')
    .leftJoin('patient_insurance as pi', 'pi.id', 'b.patient_insurance_id').leftJoin('insurance_providers as ip', 'ip.id', 'pi.provider_id')
    .where('b.id', id).first('b.*', 'p.patient_code', 'p.first_name', 'p.last_name', 'p.phone', 'u.full_name as generated_by_name', 'ip.name as insurer', 'pi.coverage_percent', 'pi.policy_number_last4');
  if (!b) throw notFound('Bill not found.');
  const items = await conn('bill_items').where({ bill_id: id }).orderBy('id');
  const payments = await conn('payments as pm').leftJoin('receipts as r', 'r.payment_id', 'pm.id').join('users as u', 'u.id', 'pm.recorded_by').where('pm.bill_id', id).orderBy('pm.received_at')
    .select('pm.*', 'r.id as receipt_id', 'r.receipt_number', 'u.full_name as recorded_by_name');
  return {
    ...billSummary(b), notes: b.notes, generatedByName: b.generated_by_name, patient: { ...billSummary(b).patient, phone: b.phone },
    insurance: b.patient_insurance_id ? { insurer: b.insurer, coveragePercent: b.coverage_percent, policyNumberMasked: `••••${b.policy_number_last4}`, appliedAt: b.insurance_applied_at } : null,
    items: items.map((i) => ({ id: i.id, category: i.category, description: i.description, quantity: i.quantity, unitPrice: i.unit_price, amount: i.amount, serviceDate: i.service_date, periodStart: i.period_start, periodEnd: i.period_end })),
    byCategory: CATEGORY_ORDER.map((c) => ({ category: c, amount: fromCents(items.filter((i) => i.category === c).reduce((s, i) => s + toCents(i.amount), 0)) })).filter((c) => c.amount > 0),
    payments: payments.map((p) => ({ id: p.id, paymentNumber: p.payment_number, amount: p.amount, method: p.method, referenceNo: p.reference_no, receivedAt: p.received_at, recordedByName: p.recorded_by_name, receiptId: p.receipt_id, receiptNumber: p.receipt_number })),
    currency: env.CURRENCY,
  };
}

/** Patients can only see their own bills (UC-50). */
export async function assertBillAccess(req, billId) {
  if (req.user.permissions.includes('billing.view')) return;
  const b = await db('bills').where({ id: billId }).first('patient_id');
  if (!b || !req.user.permissions.includes('portal.self') || b.patient_id !== req.user.patientId) throw forbidden('You can only view your own bills.');
}

/** UC-40: insurance verified locally (accepted provider, active policy, not expired). */
export async function applyInsurance(req, billId, patientInsuranceId) {
  return transaction(async (trx) => {
    const bill = await trx('bills').where({ id: billId }).forUpdate().first();
    if (!bill) throw notFound('Bill not found.');
    if (bill.patient_insurance_id) throw conflict('Insurance has already been applied to this bill.');
    const policy = await trx('patient_insurance as pi').join('insurance_providers as ip', 'ip.id', 'pi.provider_id').where('pi.id', patientInsuranceId).first('pi.*', 'ip.name', 'ip.is_active as provider_active', 'ip.max_coverage_amount');
    const today = todayStr();
    const problem = !policy || policy.patient_id !== bill.patient_id ? 'This insurance policy does not belong to the patient.'
      : !policy.is_active ? 'This insurance policy is no longer active.'
        : !policy.provider_active ? `${policy.name} is no longer an accepted insurer.`
          : policy.valid_until < today ? `This policy expired on ${policy.valid_until}.`
            : policy.valid_from > today ? `This policy is not valid until ${policy.valid_from}.` : null;
    if (problem) {
      await audit(req, { action: 'billing.insurance_apply', entityType: 'bill', entityId: billId, status: 'failure', details: { reason: problem } }, db);
      // UC-40 2-A: invalid insurance -> full amount remains payable.
      throw new AppError(422, `Invalid insurance: ${problem} The full amount remains payable.`, { code: 'INSURANCE_INVALID', fields: { patientInsuranceId: problem } });
    }
    let coverage = toCents(bill.subtotal) * (Number(policy.coverage_percent) / 100);
    if (policy.max_coverage_amount) coverage = Math.min(coverage, toCents(policy.max_coverage_amount));
    coverage = Math.round(coverage);
    const payable = toCents(bill.subtotal) - coverage;
    if (payable < toCents(bill.amount_paid)) throw conflict('The patient has already paid more than the amount payable after insurance. Insurance cannot be applied to this bill.');
    const insuranceAmount = fromCents(coverage);
    const totalPayable = fromCents(payable);
    const status = totalPayable === Number(bill.amount_paid) ? 'paid' : Number(bill.amount_paid) > 0 ? 'partially_paid' : 'unpaid';
    await trx('bills').where({ id: billId }).update({ insurance_amount: insuranceAmount, total_payable: totalPayable, status, patient_insurance_id: policy.id, insurance_applied_at: new Date(), insurance_applied_by: req.user.id, updated_at: new Date() });
    await audit(req, { action: 'billing.insurance_apply', entityType: 'bill', entityId: billId, details: { insurer: policy.name, coveragePercent: policy.coverage_percent, insuranceAmount, totalPayable } }, trx);
    trx.afterCommit(() => publishToPermission(['billing.view'], 'bills.changed', {}));
    return { insuranceAmount, totalPayable };
  });
}

/** UC-41: record a (possibly partial) payment; it may not exceed the outstanding balance. */
export async function recordPayment(req, billId, { amount, method, referenceNo, notes }) {
  const result = await transaction(async (trx) => {
    const bill = await trx('bills').where({ id: billId }).forUpdate().first();
    if (!bill) throw notFound('Bill not found.');
    if (bill.balance <= 0) throw conflict('This bill is already fully paid.');
    if (toCents(amount) <= 0) throw new AppError(422, 'Invalid payment amount.', { fields: { amount: 'Enter an amount greater than zero.' } });
    if (toCents(amount) > toCents(bill.balance)) {
      await audit(req, { action: 'billing.payment', entityType: 'bill', entityId: billId, status: 'failure', details: { reason: 'exceeds_balance', amount, balance: bill.balance } }, trx);
      throw new AppError(422, `Payment exceeds the due amount. The outstanding balance is ${env.CURRENCY} ${Number(bill.balance).toFixed(2)}.`, { code: 'PAYMENT_EXCEEDS_BALANCE', fields: { amount: `Maximum ${Number(bill.balance).toFixed(2)}` } });
    }
    const [payment] = await trx('payments').insert({ payment_number: await nextCode(trx, 'payment_number_seq'), bill_id: billId, amount, method, reference_no: referenceNo, notes, recorded_by: req.user.id }).returning('*');
    const paid = fromCents(toCents(bill.amount_paid) + toCents(amount));
    const status = toCents(paid) >= toCents(bill.total_payable) ? 'paid' : 'partially_paid';
    await trx('bills').where({ id: billId }).update({ amount_paid: paid, status, updated_at: new Date() });
    await audit(req, { action: 'billing.payment', entityType: 'bill', entityId: billId, details: { paymentNumber: payment.payment_number, amount, method, newStatus: status } }, trx);
    await notify(trx, { patientId: bill.patient_id, email: true, eventType: 'billing.payment_received', title: 'Payment received', message: `We received ${env.CURRENCY} ${Number(amount).toFixed(2)} for bill ${bill.bill_number}. Remaining balance: ${env.CURRENCY} ${fromCents(toCents(bill.total_payable) - toCents(paid)).toFixed(2)}.`, link: '/portal/bills', entityType: 'bill', entityId: billId });
    trx.afterCommit(() => publishToPermission(['billing.view', 'admissions.manage'], 'bills.changed', { patientId: bill.patient_id }));
    return payment;
  });
  return { paymentId: result.id, paymentNumber: result.payment_number, bill: await billDetail(billId) };
}

/** UC-42: one receipt per payment, with payment date, amount and remaining balance. */
export async function issueReceipt(req, paymentId) {
  return transaction(async (trx) => {
    const p = await trx('payments as pm').join('bills as b', 'b.id', 'pm.bill_id').join('patients as pt', 'pt.id', 'b.patient_id').where('pm.id', paymentId).forUpdate('pm')
      .first('pm.*', 'b.bill_number', 'b.total_payable', 'b.subtotal', 'b.insurance_amount', 'b.patient_id', 'pt.patient_code', 'pt.first_name', 'pt.last_name');
    if (!p) throw notFound('No payment has been recorded, so a receipt cannot be issued.', { code: 'NO_PAYMENT' });
    const existing = await trx('receipts').where({ payment_id: paymentId }).first();
    if (existing) return existing;
    const paidUpTo = await trx('payments').where({ bill_id: p.bill_id }).where('id', '<=', p.id).sum({ s: 'amount' }).first(); // ids are assigned in payment order
    const balanceAfter = fromCents(toCents(p.total_payable) - toCents(paidUpTo.s));
    const snapshot = {
      hospital: env.HOSPITAL_NAME, currency: env.CURRENCY, patient: { code: p.patient_code, name: `${p.first_name} ${p.last_name}` },
      billNumber: p.bill_number, billTotal: p.subtotal, insurance: p.insurance_amount, payable: p.total_payable,
      paymentNumber: p.payment_number, paymentDate: p.received_at, amountPaid: p.amount, method: p.method, referenceNo: p.reference_no, remainingBalance: balanceAfter, issuedBy: req.user.fullName,
    };
    const [r] = await trx('receipts').insert({ receipt_number: await nextCode(trx, 'receipt_number_seq'), payment_id: paymentId, patient_id: p.patient_id, amount_paid: p.amount, balance_after: balanceAfter, snapshot: JSON.stringify(snapshot), issued_by: req.user.id }).returning('*');
    await audit(req, { action: 'billing.receipt_issue', entityType: 'receipt', entityId: r.id, details: { receiptNumber: r.receipt_number, paymentNumber: p.payment_number } }, trx);
    return r;
  });
}

export async function getReceipt(req, id) {
  const r = await db('receipts as r').join('users as u', 'u.id', 'r.issued_by').where('r.id', id).first('r.*', 'u.full_name as issued_by_name');
  if (!r) throw notFound('Receipt not found.');
  if (!req.user.permissions.includes('billing.view') && !(req.user.permissions.includes('portal.self') && req.user.patientId === r.patient_id)) throw forbidden('You can only view your own receipts.');
  return { id: r.id, receiptNumber: r.receipt_number, issuedAt: r.issued_at, issuedByName: r.issued_by_name, amountPaid: r.amount_paid, balanceAfter: r.balance_after, ...r.snapshot };
}

// ----------------------------------------------------------------- insurance providers
const providerDto = (p) => ({ id: p.id, name: p.name, defaultCoveragePercent: p.default_coverage_percent, maxCoverageAmount: p.max_coverage_amount, policyNumberPattern: p.policy_number_pattern, contactPhone: p.contact_phone, isActive: p.is_active });
export const listProviders = async () => (await db('insurance_providers').orderBy('name')).map(providerDto);
export async function saveProvider(req, id, b) {
  if (b.policyNumberPattern) {
    try { new RegExp(b.policyNumberPattern); } catch { throw new AppError(422, 'The policy number pattern is not a valid expression.', { fields: { policyNumberPattern: 'Invalid pattern.' } }); }
  }
  const values = { name: b.name, default_coverage_percent: b.defaultCoveragePercent, max_coverage_amount: b.maxCoverageAmount ?? null, policy_number_pattern: b.policyNumberPattern ?? null, contact_phone: b.contactPhone ?? null, is_active: b.isActive ?? true };
  const [row] = id ? await db('insurance_providers').where({ id }).update(values).returning('*') : await db('insurance_providers').insert(values).returning('*');
  if (!row) throw notFound('Insurance provider not found.');
  await audit(req, { action: id ? 'insurance.provider_update' : 'insurance.provider_create', entityType: 'insurance_provider', entityId: row.id, details: { name: row.name } });
  return providerDto(row);
}

export async function billingPatients({ q }) {
  const query = db('patients as p').select('p.*', db.raw('COALESCE((SELECT sum(balance) FROM bills b WHERE b.patient_id = p.id), 0) AS balance'), db.raw("(SELECT count(*) FROM bills b WHERE b.patient_id = p.id)::int AS bill_count")).limit(50);
  if (q) query.where((w) => w.whereILike('p.patient_code', `%${q}%`).orWhereRaw("lower(p.first_name || ' ' || p.last_name) like lower(?)", [`%${q}%`]).orWhere('p.phone', 'like', `%${q}%`));
  else query.orderByRaw('balance DESC, p.updated_at DESC');
  return (await query).map((p) => ({ ...toSummary(p), balance: Number(p.balance), billCount: p.bill_count }));
}

/** Patients whose discharge is approved but who still have unbilled services or balances. */
export async function awaitingFinalBill() {
  const rows = await db('admissions as a').join('patients as p', 'p.id', 'a.patient_id').join('wards as w', 'w.id', 'a.ward_id')
    .where('a.status', 'active').whereNotNull('a.discharge_approved_at').select('a.id', 'a.admission_code', 'a.discharge_approved_at', 'p.id as patient_id', 'p.patient_code', 'p.first_name', 'p.last_name', 'w.name as ward_name');
  return rows.map((r) => ({ admissionId: r.id, admissionCode: r.admission_code, approvedAt: r.discharge_approved_at, wardName: r.ward_name, patient: { id: r.patient_id, patientCode: r.patient_code, fullName: `${r.first_name} ${r.last_name}` } }));
}
