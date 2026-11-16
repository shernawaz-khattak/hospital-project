import { describe, expect, it } from 'vitest';
import { assertAdmissionEligible, assertDischargeAllowed } from '../src/modules/wards/admissionIntegrity.js';

describe('admission integrity rules', () => {
  it('allows admission with an available bed and eligible patient', () => {
    expect(() => assertAdmissionEligible({ admissionStatuses: ['discharged'], bed: { status: 'available' }, patient: { id: 1 } })).not.toThrow();
  });

  it('rejects an occupied bed', () => {
    expect(() => assertAdmissionEligible({ admissionStatuses: [], bed: { status: 'occupied' }, patient: { id: 1 } })).toThrow('not available');
  });

  it('rejects a duplicate active admission', () => {
    expect(() => assertAdmissionEligible({ admissionStatuses: ['active'], bed: { status: 'available' }, patient: { id: 1 } })).toThrow('already admitted');
  });

  it('rejects invalid patients', () => {
    expect(() => assertAdmissionEligible({ admissionStatuses: [], bed: { status: 'available' }, patient: null })).toThrow('Invalid patient');
  });

  it('allows doctor discharge after approval clears bills', () => {
    expect(() => assertDischargeAllowed({ isDoctor: true, admission: { discharge_approved_at: 'now' }, outstandingBalance: 0, unbilledCount: 0 })).not.toThrow();
  });

  it('requires doctor approval for non-doctor discharge', () => {
    expect(() => assertDischargeAllowed({ isDoctor: false, admission: {}, outstandingBalance: 0, unbilledCount: 0 })).toThrow('doctor');
  });

  it('blocks discharge with an outstanding balance', () => {
    expect(() => assertDischargeAllowed({ isDoctor: true, admission: { discharge_approved_at: 'now' }, outstandingBalance: 10, unbilledCount: 0 })).toThrow('pending bills');
  });

  it('blocks discharge with unbilled services', () => {
    expect(() => assertDischargeAllowed({ isDoctor: false, admission: { discharge_approved_at: 'now' }, outstandingBalance: 0, unbilledCount: 2 })).toThrow('pending bills');
  });
});

describe('final billing and payments', () => {
  const cents = (value) => Math.round(Number(value) * 100);
  const payment = (totalPayable, amountPaid, amount) => {
    const balance = cents(totalPayable) - cents(amountPaid);
    if (balance <= 0) throw new Error('already fully paid');
    if (cents(amount) <= 0 || cents(amount) > balance) throw new Error('invalid payment');
    const paid = cents(amountPaid) + cents(amount);
    return { paid: paid / 100, balanceAfter: (cents(totalPayable) - paid) / 100, status: paid >= cents(totalPayable) ? 'paid' : 'partially_paid' };
  };

  it('calculates room and service totals', () => {
    const total = [120, 80.5, 300].reduce((sum, value) => sum + cents(value), 0);
    expect(total / 100).toBe(500.5);
  });

  it('records a partial payment and remaining balance', () => {
    expect(payment(500, 100, 125)).toEqual({ paid: 225, balanceAfter: 275, status: 'partially_paid' });
  });

  it('marks final payment as paid', () => {
    expect(payment(500, 400, 100)).toEqual({ paid: 500, balanceAfter: 0, status: 'paid' });
  });

  it('rejects duplicate attempts on a paid bill', () => {
    expect(() => payment(500, 500, 100)).toThrow('already fully paid');
  });

  it('rejects a payment over the outstanding balance', () => {
    expect(() => payment(500, 450, 75)).toThrow('invalid payment');
  });
});
