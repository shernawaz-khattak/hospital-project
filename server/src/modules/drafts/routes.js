// Autosaved form drafts (SRS UC-02: "All unsaved data must be auto saved before logout").
// Long forms save their state here every few seconds and on logout/idle timeout; the
// draft is restored after the user signs in again. Contents are encrypted at rest.
import { Router } from 'express';
import { db } from '../../db/knex.js';
import { z, validate } from '../../lib/validate.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { badRequest } from '../../lib/errors.js';

const router = Router();
const keyParam = z.object({ key: z.string().regex(/^[a-z0-9:_-]{1,80}$/, 'Invalid draft key.') });

router.get('/', async (req, res) => {
  const rows = await db('drafts').where({ user_id: req.user.id }).orderBy('updated_at', 'desc').select('form_key', 'updated_at');
  res.json({ data: rows.map((r) => ({ key: r.form_key, updatedAt: r.updated_at })) });
});

router.get('/:key', validate({ params: keyParam }), async (req, res) => {
  const row = await db('drafts').where({ user_id: req.user.id, form_key: req.validParams.key }).first();
  res.json({ draft: row ? { data: JSON.parse(decrypt(row.data_enc)), updatedAt: row.updated_at } : null });
});

router.put('/:key', validate({ params: keyParam, body: z.object({ data: z.record(z.any()) }) }), async (req, res) => {
  const json = JSON.stringify(req.body.data);
  if (json.length > 100_000) throw badRequest('Draft is too large.');
  await db('drafts')
    .insert({ user_id: req.user.id, form_key: req.validParams.key, data_enc: encrypt(json), updated_at: new Date() })
    .onConflict(['user_id', 'form_key'])
    .merge(['data_enc', 'updated_at']);
  res.json({ ok: true });
});

router.delete('/:key', validate({ params: keyParam }), async (req, res) => {
  await db('drafts').where({ user_id: req.user.id, form_key: req.validParams.key }).del();
  res.json({ ok: true });
});

export default router;
