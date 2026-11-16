export function assertNotificationOwned(notification, userId) {
  if (!notification || notification.user_id !== userId) {
    const error = new Error('Notification not found.');
    error.status = 404;
    error.code = 'NOT_FOUND';
    throw error;
  }
  return notification;
}

export function notificationIdentity(notification) {
  if (!notification?.userId || !notification?.eventType || notification.entityId == null) return null;
  return `${notification.userId}:${notification.eventType}:${notification.entityType ?? ''}:${notification.entityId}`;
}
