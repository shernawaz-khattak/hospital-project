// In-app notifications for the signed-in user (SRS FR-33, UC-47) and the live event stream.
import { Router } from 'express';
import { db } from '../../db/knex.js';
import { z, v, validate, idParam } from '../../lib/validate.js';
import { pageQuery } from '../../lib/pagination.js';
import { addClient } from '../../services/realtime.js';
import { resolveSession, SESSION_COOKIE } from '../../auth/sessions.js';
import { notFound } from '../../lib/errors.js';

const router = Router();

router.get('/', validate({ query: pageQuery.extend({ unread: z.enum(['true', 'false']).optional() }) }), async (req, res) => {
  const { page, pageSize, unread } = req.validQuery;
  const inApp = (qb) => qb.whereExists(db('notification_deliveries as d').whereRaw('d.notification_id = notifications.id').where('d.channel', 'in_app'));
  const q = db('notifications').where({ user_id: req.user.id }).modify(inApp);
  if (unread === 'true') q.where({ is_read: false });
  const [total, unreadCount, rows] = await Promise.all([
    q.clone().count({ n: '*' }).first(),
    db('notifications as unread').where({ 'unread.user_id': req.user.id, 'unread.is_read': false })
      .whereExists(db('notification_deliveries as unread_delivery')
        .whereRaw('unread_delivery.notification_id = unread.id')
        .where('unread_delivery.channel', 'in_app'))
      .count({ n: '*' }).first(),
    q.clone().orderBy('created_at', 'desc').offset((page - 1) * pageSize).limit(pageSize),
  ]);
  res.json({
    page, pageSize, total: Number(total.n), unreadCount: Number(unreadCount.n),
    data: rows.map((n) => ({ id: n.id, eventType: n.event_type, title: n.title, message: n.message, link: n.link, priority: n.priority, isRead: n.is_read, createdAt: n.created_at })),
  });
});

router.post('/:id/read', validate({ params: idParam }), async (req, res) => {
  const notification = await db('notifications').where({ id: req.validParams.id, user_id: req.user.id }).first('id');
  if (!notification) throw notFound('Notification not found.');
  await db('notifications').where({ id: notification.id, user_id: req.user.id }).update({ is_read: true, read_at: new Date() });
  res.json({ ok: true });
});

router.post('/read-many', validate({ body: z.object({ ids: z.array(v.id()).min(1).max(100) }) }), async (req, res) => {
  const updated = await db('notifications').where({ user_id: req.user.id }).whereIn('id', req.body.ids)
    .update({ is_read: true, read_at: new Date() });
  res.json({ ok: true, updated });
});

router.post('/read-all', async (req, res) => {
  await db('notifications').where({ user_id: req.user.id, is_read: false }).update({ is_read: true, read_at: new Date() });
  res.json({ ok: true });
});

export default router;

/**
 * GET /api/events — Server-Sent Events stream. Does not refresh the inactivity timer; it
 * re-checks the session every 30 s and closes when the session ends (10-minute idle rule).
 */
export async function eventStream(req, res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`event: ready\ndata: {}\n\n`);
  const remove = addClient(res, { userId: req.user.id, permissions: req.user.permissions });
  const token = req.cookies?.[SESSION_COOKIE];
  const timer = setInterval(async () => {
    try {
      const s = await resolveSession(token, { touch: false });
      if (!s || s.expired) {
        res.write('event: session-ended\ndata: {}\n\n');
        res.end();
        return;
      }
      res.write(': keep-alive\n\n');
    } catch {
      res.end();
    }
  }, 30_000);
  req.on('close', () => {
    clearInterval(timer);
    remove();
  });
}
