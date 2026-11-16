import { describe, expect, it } from 'vitest';
import { assertNotificationOwned, notificationIdentity } from '../src/modules/notifications/notificationIntegrity.js';
import { sanitizeAuditDetails } from '../src/services/auditSanitize.js';

describe('notification privacy and consistency', () => {
  it('accepts an in-app notification owned by the current user', () => {
    expect(assertNotificationOwned({ id: 4, user_id: 9 }, 9).id).toBe(4);
  });

  it('rejects another user notification as not found', () => {
    expect(() => assertNotificationOwned({ id: 4, user_id: 10 }, 9)).toThrow('Notification not found.');
  });

  it('rejects an unknown notification as not found', () => {
    expect(() => assertNotificationOwned(null, 9)).toThrow('Notification not found.');
  });

  it('builds a stable notification identity for duplicate events', () => {
    expect(notificationIdentity({ userId: 3, eventType: 'billing.payment', entityType: 'payment', entityId: 12 }))
      .toBe('3:billing.payment:payment:12');
  });

  it('does not generate an identity for an event without an entity', () => {
    expect(notificationIdentity({ userId: 3, eventType: 'system.notice' })).toBeNull();
  });
});

describe('audit details', () => {
  it('redacts passwords and tokens in nested audit details', () => {
    expect(sanitizeAuditDetails({
      actor: 'doctor',
      password: 'secret',
      nested: { accessToken: 'jwt', name: 'ward A' },
    })).toEqual({
      actor: 'doctor',
      password: '[REDACTED]',
      nested: { accessToken: '[REDACTED]', name: 'ward A' },
    });
  });

  it('scrubs sensitive values inside arrays', () => {
    expect(sanitizeAuditDetails([{ credentials: 'abc', value: 7 }])).toEqual([
      { credentials: '[REDACTED]', value: 7 },
    ]);
  });

  it('preserves ordinary audit resource details', () => {
    const details = { entityId: 42, status: 'success', changes: ['name'] };
    expect(sanitizeAuditDetails(details)).toEqual(details);
  });
});
