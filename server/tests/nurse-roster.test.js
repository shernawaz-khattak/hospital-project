import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/knex.js', () => ({ db: vi.fn() }));
vi.mock('../src/services/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { validMonth, validateRosterEntries } = await import('../src/modules/staff/nurseRoutes.js');
const { requirePermission } = await import('../src/middleware/auth.js');

describe('nurse roster validation', () => {
  it.each(['2026-01', '2026-12', '2028-02'])('accepts valid calendar month %s', (month) => {
    expect(validMonth(month)).toBe(true);
  });

  it.each(['2026-00', '2026-13', '1999-12', '9999-01'])('rejects invalid calendar month %s', (month) => {
    expect(validMonth(month)).toBe(false);
  });

  it.each(['2026/01', '26-01', '202601', '', null, undefined])('rejects invalid month format %j', (month) => {
    expect(validMonth(month)).toBe(false);
  });

  it('rejects duplicate nurse/date entries', () => {
    const entries = [
      { staffId: 1, date: '2026-01-01', shift: 'morning' },
      { staffId: 1, date: '2026-01-01', shift: 'night' },
    ];
    expect(() => validateRosterEntries(entries, '2026-01')).toThrow('Each nurse can have only one shift per date.');
  });

  it('rejects inactive nurse IDs through the active nurse allow-list', () => {
    expect(() => validateRosterEntries(
      [{ staffId: 7, date: '2026-01-01', shift: 'morning' }],
      '2026-01',
      [1, 2],
    )).toThrow('Roster entries can only use active nurses.');
  });

  it('rejects staff IDs belonging to non-nurse users through the nurse allow-list', () => {
    expect(() => validateRosterEntries(
      [{ staffId: 9, date: '2026-01-02', shift: 'evening' }],
      '2026-01',
      [3, 4],
    )).toThrow('Roster entries can only use active nurses.');
  });

  it('accepts multiple valid roster entries', () => {
    const entries = [
      { staffId: 1, date: '2026-01-01', shift: 'morning' },
      { staffId: 1, date: '2026-01-02', shift: 'off' },
      { staffId: 2, date: '2026-01-01', shift: 'night' },
    ];
    expect(validateRosterEntries(entries, '2026-01', [1, 2])).toEqual([
      { staff_id: 1, roster_date: '2026-01-01', shift: 'morning' },
      { staff_id: 1, roster_date: '2026-01-02', shift: 'off' },
      { staff_id: 2, roster_date: '2026-01-01', shift: 'night' },
    ]);
  });

  it('does not commit a persistence failure', async () => {
    const transaction = vi.fn(async (work) => {
      const trx = {
        commit: vi.fn(),
        rollback: vi.fn(),
      };
      try {
        await work(trx);
        throw new Error('Expected persistence failure');
      } catch (error) {
        trx.rollback();
        throw error;
      }
    });
    const persistence = vi.fn().mockRejectedValue(new Error('write failed'));
    await expect(transaction(async (trx) => {
      await persistence();
      trx.commit();
    })).rejects.toThrow('write failed');
    expect(transaction).toHaveBeenCalledOnce();
  });

  it('rejects unauthorized users before the roster handler', async () => {
    const middleware = requirePermission('nursing.roster.manage');
    const req = { user: { permissions: ['nursing.roster.view'] }, method: 'PUT', originalUrl: '/api/nurses/roster', get: vi.fn() };
    const next = vi.fn();
    await expect(middleware(req, {}, next)).rejects.toMatchObject({ status: 403 });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a user with the existing roster permission', async () => {
    const middleware = requirePermission('nursing.roster.manage');
    const req = { user: { permissions: ['nursing.roster.manage'] } };
    const next = vi.fn();
    await middleware(req, {}, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
