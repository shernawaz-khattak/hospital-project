// Appointments (SRS FR-11, FR-12, FR-13; UC-15 Book, UC-16 Cancel/Reschedule, UC-17 Waitlist).
import { db } from '../../db/knex.js';
import { transaction } from '../../db/tx.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { nextCode } from '../../lib/codes.js';
import { addDays, localDateTime, minutesToTime, nowTimeStr, timeToMinutes, todayStr, weekdayOf } from '../../lib/dates.js';
import { audit } from '../../services/audit.js';
import { notify } from '../../services/notifications.js';
import { publishToPermission } from '../../services/realtime.js';

const LIVE = ['scheduled', 'cancellation_requested'];
const MAX_DAYS_AHEAD = 90;
export const CANCEL_APPROVAL_WINDOW_MIN = 60; // UC-16: cancellations within 1 hour need admin approval

async function doctorWithName(doctorId, conn = db) {
  const d = await conn('doctors as d').join('staff as s', 's.id', 'd.staff_id').join('users as u', 'u.id', 's.user_id')
    .where('d.id', doctorId).first('d.*', 'u.full_name', 'u.id as user_id', 'u.status as user_status');
  if (!d) throw notFound('Doctor not found.');
  return d;
}

/** All slots of a doctor on a date with availability. */
export async function getSlots(doctorId, date, conn = db) {
  const doctor = await doctorWithName(doctorId, conn);
  const blocks = await conn('doctor_schedules').where({ doctor_id: doctorId, weekday: weekdayOf(date) }).orderBy('start_time');
  const booked = await conn('appointments').where({ doctor_id: doctorId, appointment_date: date }).whereIn('status', LIVE).select('start_time');
  const bookedSet = new Set(booked.map((b) => b.start_time.slice(0, 5)));
  const isToday = date === todayStr();
  const nowMin = timeToMinutes(nowTimeStr());
  const slots = [];
  for (const b of blocks) {
    for (let m = timeToMinutes(b.start_time); m + doctor.slot_minutes <= timeToMinutes(b.end_time); m += doctor.slot_minutes) {
      const start = minutesToTime(m);
      const past = date < todayStr() || (isToday && m <= nowMin);
      slots.push({ startTime: start, endTime: minutesToTime(m + doctor.slot_minutes), available: !past && !bookedSet.has(start), booked: bookedSet.has(start), past });
    }
  }
  return { doctor: { id: doctor.id, fullName: doctor.full_name, specialization: doctor.specialization, slotMinutes: doctor.slot_minutes, isActive: doctor.is_active }, date, slots, worksThisDay: blocks.length > 0 };
}

/** UC-15 2-A: next available slots from a date/time onward (same day first, then following days). */
export async function suggestSlots(doctorId, date, afterTime = null, limit = 3) {
  const out = [];
  for (let i = 0; i < 21 && out.length < limit; i++) {
    const d = addDays(date, i);
    if (d < todayStr()) continue;
    const { slots } = await getSlots(doctorId, d);
    for (const s of slots) {
      if (!s.available) continue;
      if (i === 0 && afterTime && timeToMinutes(s.startTime) <= timeToMinutes(afterTime)) continue;
      out.push({ date: d, startTime: s.startTime, endTime: s.endTime });
      if (out.length >= limit) break;
    }
  }
  return out;
}

export const appointmentSelect = [
  'a.*', 'p.patient_code', 'p.first_name', 'p.last_name', 'p.phone as patient_phone', 'p.user_id as patient_user_id',
  'u.full_name as doctor_name', 'd.specialization', 'd.doctor_code', 'dep.name as department_name',
];
export const appointmentQuery = (conn = db) =>
  conn('appointments as a')
    .join('patients as p', 'p.id', 'a.patient_id')
    .join('doctors as d', 'd.id', 'a.doctor_id')
    .join('staff as s', 's.id', 'd.staff_id')
    .join('users as u', 'u.id', 's.user_id')
    .join('departments as dep', 'dep.id', 'd.department_id');

export function toDto(a) {
  return {
    id: a.id, appointmentCode: a.appointment_code, date: a.appointment_date, startTime: a.start_time.slice(0, 5), endTime: a.end_time.slice(0, 5),
    tokenNumber: a.token_number, status: a.status, reason: a.reason, bookingChannel: a.booking_channel, cancellationReason: a.cancellation_reason, cancelledAt: a.cancelled_at,
    completedAt: a.completed_at, rescheduledFromId: a.rescheduled_from_id, createdAt: a.created_at,
    patient: { id: a.patient_id, patientCode: a.patient_code, fullName: `${a.first_name} ${a.last_name}`, phone: a.patient_phone },
    doctor: { id: a.doctor_id, fullName: a.doctor_name, specialization: a.specialization, doctorCode: a.doctor_code, departmentName: a.department_name },
    startsAt: localDateTime(a.appointment_date, a.start_time),
  };
}

export async function getAppointment(id, conn = db) {
  const row = await appointmentQuery(conn).where('a.id', id).first(appointmentSelect);
  if (!row) throw notFound('Appointment not found.');
  return row;
}

/** Patients may act only on their own appointments; doctors only view their own. */
export function assertCanAct(req, appt) {
  if (req.user.permissions.includes('appointments.manage')) return;
  if (req.user.permissions.includes('portal.self') && req.user.patientId === appt.patient_id) return;
  throw forbidden('You can only manage your own appointments.');
}

async function validateSlot(conn, doctor, date, startTime) {
  if (!doctor.is_active || doctor.user_status !== 'active') throw new AppError(422, 'This doctor is not currently accepting appointments.', { fields: { doctorId: 'Doctor is not available.' } });
  if (date < todayStr()) throw new AppError(422, 'Appointments cannot be booked in the past.', { fields: { date: 'Choose today or a future date.' } });
  if (date > addDays(todayStr(), MAX_DAYS_AHEAD)) throw new AppError(422, `Appointments can be booked up to ${MAX_DAYS_AHEAD} days ahead.`, { fields: { date: 'Too far in the future.' } });
  const { slots, worksThisDay } = await getSlots(doctor.id, date, conn);
  if (!worksThisDay) throw conflict('The doctor is not available on this day.', { code: 'DOCTOR_UNAVAILABLE', details: { suggestions: await suggestSlots(doctor.id, date) } });
  const slot = slots.find((s) => s.startTime === startTime);
  if (!slot) throw new AppError(422, 'Choose one of the doctor\'s available time slots.', { fields: { startTime: 'Not a valid slot for this doctor.' } });
  if (slot.past) throw new AppError(422, 'This time slot has already passed.', { fields: { startTime: 'This slot has passed.' } });
  if (slot.booked) {
    throw conflict('This appointment slot is already booked.', { code: 'SLOT_TAKEN', fields: { startTime: 'Already booked.' }, details: { suggestions: await suggestSlots(doctor.id, date, startTime) } });
  }
  return slot;
}

async function insertAppointment(trx, req, { patientId, doctor, date, slot, reason, channel, rescheduledFromId = null }) {
  // Serialise bookings per doctor/day so token numbers are sequential and race-free.
  await trx.raw('SELECT pg_advisory_xact_lock(?, ?)', [doctor.id, Number(date.replaceAll('-', ''))]);
  const clash = await trx('appointments').where({ doctor_id: doctor.id, appointment_date: date, start_time: slot.startTime }).whereIn('status', LIVE).first();
  if (clash) throw conflict('This appointment slot is already booked.', { code: 'SLOT_TAKEN', details: { suggestions: await suggestSlots(doctor.id, date, slot.startTime) } });
  const own = await trx('appointments').where({ patient_id: patientId, appointment_date: date, start_time: slot.startTime }).whereIn('status', LIVE).first();
  if (own) throw conflict('This patient already has another appointment at this time.', { code: 'PATIENT_BUSY', fields: { startTime: 'Patient already booked at this time.' } });
  const same = await trx('appointments').where({ patient_id: patientId, doctor_id: doctor.id, appointment_date: date }).whereIn('status', LIVE).first();
  if (same) throw conflict('This patient already has an appointment with this doctor on this date.', { code: 'DUPLICATE_BOOKING' });

  const { max } = await trx('appointments').where({ doctor_id: doctor.id, appointment_date: date }).max({ max: 'token_number' }).first();
  const [row] = await trx('appointments').insert({
    appointment_code: await nextCode(trx, 'appointment_code_seq'), patient_id: patientId, doctor_id: doctor.id, appointment_date: date,
    start_time: slot.startTime, end_time: slot.endTime, token_number: (max ?? 0) + 1, reason, booking_channel: channel, booked_by: req.user.id,
    rescheduled_from_id: rescheduledFromId,
  }).returning('*');
  return row;
}

async function loadPatient(conn, patientId) {
  const p = await conn('patients').where({ id: patientId }).first();
  if (!p) throw new AppError(422, 'Invalid patient ID. Please check and re-enter it.', { fields: { patientId: 'Patient not found.' } });
  if (p.status === 'inactive') throw new AppError(422, 'This patient record is inactive.', { fields: { patientId: 'Inactive patient.' } });
  return p;
}

export async function book(req, { patientId, doctorId, date, startTime, reason, waitlistEntryId }) {
  if (req.user.role === 'patient' && patientId !== req.user.patientId) throw forbidden('You can only book appointments for yourself.');
  const doctor = await doctorWithName(doctorId);
  const slot = await validateSlot(db, doctor, date, startTime);
  const result = await transaction(async (trx) => {
    const patient = await loadPatient(trx, patientId);
    let channel = req.user.role === 'patient' ? 'portal' : 'reception';
    if (waitlistEntryId) {
      const entry = await trx('waitlist_entries').where({ id: waitlistEntryId }).forUpdate().first();
      if (!entry || !['waiting', 'notified'].includes(entry.status) || entry.patient_id !== patientId || entry.doctor_id !== doctorId) throw badRequest('This waitlist entry is not open for this patient and doctor.');
      channel = 'waitlist';
    }
    const row = await insertAppointment(trx, req, { patientId, doctor, date, slot, reason, channel });
    if (waitlistEntryId) await trx('waitlist_entries').where({ id: waitlistEntryId }).update({ status: 'booked', appointment_id: row.id, closed_at: new Date() });
    await audit(req, { action: 'appointment.create', entityType: 'appointment', entityId: row.id, details: { code: row.appointment_code, doctorId, date, startTime, token: row.token_number, channel } }, trx);
    // UC-15 step 6: send a confirmation.
    await notify(trx, {
      patientId, email: true, eventType: 'appointment.confirmed', title: 'Appointment confirmed',
      message: `Your appointment with ${doctor.full_name} is confirmed for ${date} at ${startTime}. Token number: ${row.token_number}. Appointment ID: ${row.appointment_code}.`,
      link: '/portal/appointments', entityType: 'appointment', entityId: row.id,
    });
    await notify(trx, {
      userIds: [doctor.user_id], eventType: 'appointment.booked', title: 'New appointment',
      message: `${patient.first_name} ${patient.last_name} (${patient.patient_code}) booked for ${date} ${startTime}, token ${row.token_number}.`,
      link: '/doctor/schedule', entityType: 'appointment', entityId: row.id,
    });
    trx.afterCommit(() => publishToPermission(['appointments.view', 'portal.self'], 'appointments.changed', { doctorId, date }));
    return row;
  });
  return toDto(await getAppointment(result.id));
}

/** Minutes until the appointment starts (negative when in the past). */
const minutesUntil = (a) => (localDateTime(a.appointment_date, a.start_time).getTime() - Date.now()) / 60000;

export async function cancel(req, id, reason) {
  const appt = await getAppointment(id);
  assertCanAct(req, appt);
  if (appt.status === 'cancellation_requested') throw conflict('A cancellation request for this appointment is already awaiting admin approval.');
  if (appt.status !== 'scheduled') throw conflict(`This appointment is ${appt.status.replace('_', ' ')} and cannot be cancelled.`);
  const mins = minutesUntil(appt);
  if (mins <= 0) throw conflict('This appointment time has already passed. Mark it as a no-show instead.');

  if (mins <= CANCEL_APPROVAL_WINDOW_MIN) {
    // UC-16 1-A: within 1 hour of the appointment -> admin approval required.
    await transaction(async (trx) => {
      const n = await trx('appointments').where({ id, status: 'scheduled' }).update({ status: 'cancellation_requested', updated_at: new Date() });
      if (!n) throw conflict('This appointment was changed by someone else. Refresh and try again.');
      const [reqRow] = await trx('appointment_cancellation_requests').insert({ appointment_id: id, requested_by: req.user.id, reason }).returning('*');
      await audit(req, { action: 'appointment.cancellation_requested', entityType: 'appointment', entityId: id, details: { reason, minutesBefore: Math.round(mins) } }, trx);
      await notify(trx, {
        permission: 'appointments.approve_cancellation', eventType: 'appointment.cancellation_approval', priority: 'high', title: 'Cancellation needs approval',
        message: `${appt.first_name} ${appt.last_name}'s appointment with ${appt.doctor_name} at ${appt.start_time.slice(0, 5)} today was asked to be cancelled less than 1 hour before. Reason: ${reason}`,
        link: '/admin/cancellation-requests', entityType: 'cancellation_request', entityId: reqRow.id,
      });
    });
    return { pendingApproval: true, message: 'This appointment starts within 1 hour, so the cancellation has been sent to an administrator for approval.' };
  }
  await transaction((trx) => applyCancellation(trx, req, appt, reason));
  return { pendingApproval: false, message: 'Appointment cancelled.' };
}

async function applyCancellation(trx, req, appt, reason, { approvedBy = null } = {}) {
  const n = await trx('appointments').where({ id: appt.id }).whereIn('status', ['scheduled', 'cancellation_requested']).update({ status: 'cancelled', cancellation_reason: reason, cancelled_at: new Date(), cancelled_by: req.user.id, updated_at: new Date() });
  if (!n) throw conflict('This appointment was changed by someone else. Refresh and try again.');
  await audit(req, { action: 'appointment.cancel', entityType: 'appointment', entityId: appt.id, details: { reason, approvedBy } }, trx);
  const doctorUser = await trx('doctors as d').join('staff as s', 's.id', 'd.staff_id').where('d.id', appt.doctor_id).first('s.user_id');
  // UC-16 steps 5-6: notify the doctor and confirm to the patient.
  await notify(trx, { userIds: [doctorUser.user_id], eventType: 'appointment.cancelled', title: 'Appointment cancelled', message: `${appt.first_name} ${appt.last_name}'s appointment on ${appt.appointment_date} at ${appt.start_time.slice(0, 5)} was cancelled. Reason: ${reason}`, link: '/doctor/schedule', entityType: 'appointment', entityId: appt.id });
  await notify(trx, { patientId: appt.patient_id, email: true, eventType: 'appointment.cancelled', title: 'Appointment cancelled', message: `Your appointment ${appt.appointment_code} with ${appt.doctor_name} on ${appt.appointment_date} at ${appt.start_time.slice(0, 5)} has been cancelled.`, link: '/portal/appointments', entityType: 'appointment', entityId: appt.id });
  await offerFreedSlot(trx, appt.doctor_id, appt.appointment_date, appt.start_time.slice(0, 5));
  trx.afterCommit(() => publishToPermission(['appointments.view', 'portal.self', 'waitlist.manage'], 'appointments.changed', { doctorId: appt.doctor_id, date: appt.appointment_date }));
}

export async function reschedule(req, id, { date, startTime, reason }) {
  const appt = await getAppointment(id);
  assertCanAct(req, appt);
  if (appt.status !== 'scheduled') throw conflict('Only scheduled appointments can be rescheduled.');
  if (minutesUntil(appt) <= 0) throw conflict('This appointment time has already passed and cannot be rescheduled.');
  // Moving an appointment frees its slot just like a cancellation, so the same 1-hour rule applies.
  if (minutesUntil(appt) <= CANCEL_APPROVAL_WINDOW_MIN) {
    throw conflict('This appointment starts within 1 hour, so it cannot be moved directly. Request a cancellation (an administrator must approve it) and then book a new slot.', { code: 'WITHIN_ONE_HOUR' });
  }
  if (appt.appointment_date === date && appt.start_time.slice(0, 5) === startTime) throw new AppError(422, 'Choose a different date or time.', { fields: { startTime: 'Same as the current slot.' } });
  const doctor = await doctorWithName(appt.doctor_id);
  const slot = await validateSlot(db, doctor, date, startTime);
  const created = await transaction(async (trx) => {
    const moved = await trx('appointments').where({ id, status: 'scheduled' }).update({ status: 'rescheduled', cancellation_reason: reason, cancelled_at: new Date(), cancelled_by: req.user.id, updated_at: new Date() });
    if (!moved) throw conflict('This appointment was changed by someone else. Refresh and try again.');
    const row = await insertAppointment(trx, req, { patientId: appt.patient_id, doctor, date, slot, reason: appt.reason, channel: appt.booking_channel, rescheduledFromId: id });
    await audit(req, { action: 'appointment.reschedule', entityType: 'appointment', entityId: id, details: { reason, newAppointmentId: row.id, from: `${appt.appointment_date} ${appt.start_time.slice(0, 5)}`, to: `${date} ${startTime}` } }, trx);
    await notify(trx, { userIds: [doctor.user_id], eventType: 'appointment.rescheduled', title: 'Appointment rescheduled', message: `${appt.first_name} ${appt.last_name} moved from ${appt.appointment_date} ${appt.start_time.slice(0, 5)} to ${date} ${startTime}. Reason: ${reason}`, link: '/doctor/schedule', entityType: 'appointment', entityId: row.id });
    await notify(trx, { patientId: appt.patient_id, email: true, eventType: 'appointment.rescheduled', title: 'Appointment rescheduled', message: `Your appointment with ${doctor.full_name} is now on ${date} at ${startTime}. New token number: ${row.token_number}. Appointment ID: ${row.appointment_code}.`, link: '/portal/appointments', entityType: 'appointment', entityId: row.id });
    await offerFreedSlot(trx, appt.doctor_id, appt.appointment_date, appt.start_time.slice(0, 5));
    trx.afterCommit(() => publishToPermission(['appointments.view', 'portal.self', 'waitlist.manage'], 'appointments.changed', { doctorId: appt.doctor_id }));
    return row;
  });
  return toDto(await getAppointment(created.id));
}

// ----------------------------------------------------------------- cancellation approvals (admin)
export async function listCancellationRequests(status = 'pending') {
  const rows = await db('appointment_cancellation_requests as r')
    .join('appointments as a', 'a.id', 'r.appointment_id')
    .join('patients as p', 'p.id', 'a.patient_id')
    .join('doctors as d', 'd.id', 'a.doctor_id').join('staff as s', 's.id', 'd.staff_id').join('users as du', 'du.id', 's.user_id')
    .join('users as ru', 'ru.id', 'r.requested_by')
    .leftJoin('users as dec', 'dec.id', 'r.decided_by')
    .modify((q) => status !== 'all' && q.where('r.status', status))
    .orderBy('r.created_at', 'desc').limit(200)
    .select('r.*', 'a.appointment_code', 'a.appointment_date', 'a.start_time', 'p.patient_code', 'p.first_name', 'p.last_name', 'du.full_name as doctor_name', 'ru.full_name as requested_by_name', 'dec.full_name as decided_by_name');
  return rows.map((r) => ({
    id: r.id, status: r.status, reason: r.reason, createdAt: r.created_at, decidedAt: r.decided_at, decisionNote: r.decision_note, decidedByName: r.decided_by_name,
    requestedByName: r.requested_by_name, appointmentId: r.appointment_id, appointmentCode: r.appointment_code, date: r.appointment_date, startTime: r.start_time.slice(0, 5),
    patientName: `${r.first_name} ${r.last_name}`, patientCode: r.patient_code, doctorName: r.doctor_name,
  }));
}

export async function decideCancellation(req, requestId, approve, note) {
  await transaction(async (trx) => {
    const r = await trx('appointment_cancellation_requests').where({ id: requestId }).forUpdate().first();
    if (!r) throw notFound('Cancellation request not found.');
    if (r.status !== 'pending') throw conflict('This request has already been decided.');
    const appt = await getAppointment(r.appointment_id, trx);
    await trx('appointment_cancellation_requests').where({ id: requestId }).update({ status: approve ? 'approved' : 'rejected', decided_by: req.user.id, decided_at: new Date(), decision_note: note });
    if (approve) {
      await applyCancellation(trx, req, appt, r.reason, { approvedBy: req.user.id });
    } else {
      await trx('appointments').where({ id: appt.id }).update({ status: 'scheduled', updated_at: new Date() });
      await audit(req, { action: 'appointment.cancellation_rejected', entityType: 'appointment', entityId: appt.id, details: { note } }, trx);
      await notify(trx, { patientId: appt.patient_id, email: true, eventType: 'appointment.cancellation_rejected', title: 'Cancellation not approved', message: `The cancellation of appointment ${appt.appointment_code} was not approved and it remains scheduled.${note ? ` Note: ${note}` : ''}`, link: '/portal/appointments' });
    }
    await notify(trx, { userIds: [r.requested_by], eventType: 'appointment.cancellation_decided', title: approve ? 'Cancellation approved' : 'Cancellation rejected', message: `Appointment ${appt.appointment_code}: cancellation ${approve ? 'approved' : 'rejected'}.`, entityType: 'appointment', entityId: appt.id });
  });
}

// ----------------------------------------------------------------- status changes
export async function markCompleted(req, id) {
  const appt = await getAppointment(id);
  if (req.user.doctorId !== appt.doctor_id) throw forbidden('Only the consulting doctor can complete this appointment.');
  if (appt.status !== 'scheduled') throw conflict('Only scheduled appointments can be completed.');
  if (appt.appointment_date > todayStr()) throw conflict('Future appointments cannot be completed yet.');
  await db('appointments').where({ id }).update({ status: 'completed', completed_at: new Date(), updated_at: new Date() });
  await audit(req, { action: 'appointment.complete', entityType: 'appointment', entityId: id });
}

export async function markNoShow(req, id) {
  const appt = await getAppointment(id);
  if (!(req.user.permissions.includes('appointments.manage') || req.user.doctorId === appt.doctor_id)) throw forbidden();
  if (appt.status !== 'scheduled') throw conflict('Only scheduled appointments can be marked as no-show.');
  if (minutesUntil(appt) > 0) throw conflict('An appointment can be marked as no-show only after its start time.');
  await db('appointments').where({ id }).update({ status: 'no_show', updated_at: new Date() });
  await audit(req, { action: 'appointment.no_show', entityType: 'appointment', entityId: id });
}

// ----------------------------------------------------------------- waitlist (UC-17)
/** When a slot frees up, notify the first waiting patient (first-come first-served). */
export async function offerFreedSlot(trx, doctorId, date, startTime) {
  if (date < todayStr()) return;
  const entry = await trx('waitlist_entries as w').join('patients as p', 'p.id', 'w.patient_id')
    .where({ 'w.doctor_id': doctorId, 'w.preferred_date': date, 'w.status': 'waiting' })
    .orderBy('w.created_at').first('w.*', 'p.first_name', 'p.last_name', 'p.patient_code');
  if (!entry) return;
  const doctor = await doctorWithName(doctorId, trx);
  await trx('waitlist_entries').where({ id: entry.id }).update({ status: 'notified', notified_at: new Date() });
  // UC-17 step 6: notify the receptionist and the patient.
  await notify(trx, { patientId: entry.patient_id, email: true, priority: 'high', eventType: 'waitlist.slot_available', title: 'A slot is now available', message: `A slot with ${doctor.full_name} on ${date} at ${startTime} has opened. Please contact reception or book through the portal to confirm.`, link: '/portal/appointments', entityType: 'waitlist', entityId: entry.id });
  await notify(trx, { permission: 'waitlist.manage', priority: 'high', eventType: 'waitlist.slot_available', title: 'Waitlist: slot available', message: `${entry.first_name} ${entry.last_name} (${entry.patient_code}) is first on the waitlist for ${doctor.full_name} on ${date}. Freed slot: ${startTime}.`, link: '/waitlist', entityType: 'waitlist', entityId: entry.id });
}

export async function addToWaitlist(req, { patientId, doctorId, preferredDate, notes }) {
  const { slots, worksThisDay } = await getSlots(doctorId, preferredDate);
  if (preferredDate < todayStr()) throw new AppError(422, 'Choose today or a future date.', { fields: { preferredDate: 'Choose today or a future date.' } });
  if (!worksThisDay) throw conflict('The doctor does not work on this day. Choose another date.');
  // UC-17 pre-condition: all slots for the requested date must be full.
  if (slots.some((s) => s.available)) {
    throw conflict('There are still free slots on this date. Book an appointment directly instead.', { code: 'SLOTS_AVAILABLE', details: { suggestions: slots.filter((s) => s.available).slice(0, 3).map((s) => ({ date: preferredDate, startTime: s.startTime })) } });
  }
  const patient = await loadPatient(db, patientId);
  const [row] = await db('waitlist_entries').insert({ patient_id: patientId, doctor_id: doctorId, preferred_date: preferredDate, notes, created_by: req.user.id }).returning('*');
  const position = await db('waitlist_entries').where({ doctor_id: doctorId, preferred_date: preferredDate }).whereIn('status', ['waiting', 'notified']).where('id', '<=', row.id).count({ n: '*' }).first();
  await audit(req, { action: 'waitlist.add', entityType: 'waitlist', entityId: row.id, details: { patientCode: patient.patient_code, doctorId, preferredDate } });
  publishToPermission('waitlist.manage', 'waitlist.changed', {});
  return { id: row.id, position: Number(position.n), createdAt: row.created_at };
}

export async function listWaitlist({ status, doctorId, date }) {
  const q = db('waitlist_entries as w')
    .join('patients as p', 'p.id', 'w.patient_id')
    .join('doctors as d', 'd.id', 'w.doctor_id').join('staff as s', 's.id', 'd.staff_id').join('users as u', 'u.id', 's.user_id')
    .leftJoin('appointments as a', 'a.id', 'w.appointment_id')
    .orderBy([{ column: 'w.preferred_date' }, { column: 'w.created_at' }])
    .select('w.*', 'p.patient_code', 'p.first_name', 'p.last_name', 'p.phone', 'u.full_name as doctor_name', 'd.specialization', 'a.appointment_code');
  if (status === 'open' || !status) q.whereIn('w.status', ['waiting', 'notified']);
  else if (status !== 'all') q.where('w.status', status);
  if (doctorId) q.where('w.doctor_id', doctorId);
  if (date) q.where('w.preferred_date', date);
  const rows = await q.limit(500);
  // FCFS position within each doctor/date queue
  const pos = {};
  return rows.map((r) => {
    const key = `${r.doctor_id}|${r.preferred_date}`;
    const open = ['waiting', 'notified'].includes(r.status);
    if (open) pos[key] = (pos[key] ?? 0) + 1;
    return {
      id: r.id, status: r.status, preferredDate: r.preferred_date, notes: r.notes, createdAt: r.created_at, notifiedAt: r.notified_at, position: open ? pos[key] : null,
      patient: { id: r.patient_id, patientCode: r.patient_code, fullName: `${r.first_name} ${r.last_name}`, phone: r.phone },
      doctor: { id: r.doctor_id, fullName: r.doctor_name, specialization: r.specialization }, appointmentCode: r.appointment_code,
    };
  });
}

export async function removeFromWaitlist(req, id, reason) {
  const n = await db('waitlist_entries').where({ id }).whereIn('status', ['waiting', 'notified']).update({ status: 'cancelled', closed_at: new Date(), notes: db.raw("coalesce(notes || ' | ', '') || ?", [`Removed: ${reason ?? 'no reason given'}`]) });
  if (!n) throw notFound('Open waitlist entry not found.');
  await audit(req, { action: 'waitlist.remove', entityType: 'waitlist', entityId: id, details: { reason } });
  publishToPermission('waitlist.manage', 'waitlist.changed', {});
}

// ----------------------------------------------------------------- reminders (scheduler)
/** Sends one reminder for each appointment in the next 24 hours. */
export async function sendDueReminders() {
  const today = todayStr();
  const rows = await appointmentQuery().where('a.status', 'scheduled').whereNull('a.reminder_sent_at').whereIn('a.appointment_date', [today, addDays(today, 1)]).select(appointmentSelect);
  let sent = 0;
  for (const a of rows) {
    const mins = minutesUntil(a);
    if (mins <= 0 || mins > 24 * 60) continue;
    await transaction(async (trx) => {
      await trx('appointments').where({ id: a.id }).update({ reminder_sent_at: new Date() });
      await notify(trx, { patientId: a.patient_id, email: true, eventType: 'appointment.reminder', title: 'Appointment reminder', message: `Reminder: you have an appointment with ${a.doctor_name} on ${a.appointment_date} at ${a.start_time.slice(0, 5)} (token ${a.token_number}).`, link: '/portal/appointments', entityType: 'appointment', entityId: a.id });
    });
    sent += 1;
  }
  return sent;
}
