import request from 'supertest';
import { createApp } from '../src/app.js';
import { db } from '../src/db/knex.js';
import { seedAll } from '../src/db/seed/index.js';
import { DEMO_PASSWORD } from '../src/db/seed/organization.js';
import { addDays, todayStr, weekdayOf } from '../src/lib/dates.js';

export const app = createApp();
export { db, DEMO_PASSWORD, addDays, todayStr };

/** Fresh demo data (without generated activity) for a test file. */
export async function resetData() {
  return seedAll(db, { withActivity: false });
}

/** A signed-in client: every request carries the CSRF header and the session cookie. */
export async function login(username, password = DEMO_PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').set('X-Requested-With', 'hms').send({ username, password });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return wrap(agent);
}

export function anon() {
  return wrap(request.agent(app));
}

function wrap(agent) {
  const h = (r) => r.set('X-Requested-With', 'hms');
  return {
    raw: agent,
    get: (u) => h(agent.get(u)),
    post: (u, body) => h(agent.post(u)).send(body ?? {}),
    put: (u, body) => h(agent.put(u)).send(body ?? {}),
    patch: (u, body) => h(agent.patch(u)).send(body ?? {}),
    delete: (u, body) => h(agent.delete(u)).send(body ?? {}),
  };
}

/** Next date (from tomorrow) that falls on the given weekday (0 = Sunday). */
export function nextWeekday(wd, from = addDays(todayStr(), 1)) {
  let d = from;
  while (weekdayOf(d) !== wd) d = addDays(d, 1);
  return d;
}

export const patientUser = (n) => `P-${new Date().getFullYear()}-${String(n).padStart(6, '0')}`;

/** Wait until async after-commit work (notifications) has flushed. */
export const settle = () => new Promise((r) => setTimeout(r, 150));

export async function lastOutboxTo(email) {
  return db('outbound_emails').where({ to_address: email }).orderBy('id', 'desc').first();
}
