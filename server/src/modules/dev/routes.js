// Development-only mail outbox. Mounted ONLY when NODE_ENV=development and no SMTP server
// is configured. It lists emails the system *would* have sent; they were not delivered.
import { Router } from 'express';
import { db } from '../../db/knex.js';

const router = Router();

router.get('/outbox', async (_req, res) => {
  const rows = await db('outbound_emails').orderBy('created_at', 'desc').limit(50);
  res.json({
    notice: 'Development outbox: these messages were captured locally and NOT delivered to any mailbox. Configure SMTP_* variables for real delivery.',
    data: rows.map((r) => ({ id: r.id, to: r.to_address, subject: r.subject, body: r.body_text, createdAt: r.created_at })),
  });
});

export default router;
