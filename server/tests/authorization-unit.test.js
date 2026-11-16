import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/knex.js', () => ({
  db: vi.fn(() => ({
    where: vi.fn(() => ({ first: vi.fn().mockResolvedValue({ patient_id: 10 }) })),
  })),
}));
vi.mock('../src/db/tx.js', () => ({ transaction: vi.fn((work) => work({})) }));
vi.mock('../src/services/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/services/notifications.js', () => ({ notify: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/services/realtime.js', () => ({ publishToPermission: vi.fn() }));

const { assertCanAct, book } = await import('../src/modules/appointments/service.js');
const { assertBillAccess } = await import('../src/modules/billing/service.js');

describe('authorization ownership checks', () => {
  it('allows a patient to act on their own appointment', () => {
    expect(() => assertCanAct({
      user: { permissions: ['portal.self'], patientId: 10 },
    }, { patient_id: 10 })).not.toThrow();
  });

  it('rejects a patient acting on another patient appointment', () => {
    expect(() => assertCanAct({
      user: { permissions: ['portal.self'], patientId: 10 },
    }, { patient_id: 11 })).toThrow('You can only manage your own appointments.');
  });

  it('rejects booking another patient from the portal service', async () => {
    await expect(book({
      user: { role: 'patient', patientId: 10, permissions: ['portal.self'], id: 1 },
    }, { patientId: 11 })).rejects.toThrow('You can only book appointments for yourself.');
  });

  it('rejects a portal user viewing another patient bill', async () => {
    await expect(assertBillAccess({
      user: { permissions: ['portal.self'], patientId: 11 },
    }, 20)).rejects.toThrow('You can only view your own bills.');
  });

  it('allows staff with billing view permission to access a bill', async () => {
    await expect(assertBillAccess({
      user: { permissions: ['billing.view'], patientId: null },
    }, 20)).resolves.toBeUndefined();
  });
});
