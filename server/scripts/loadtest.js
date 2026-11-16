// Load test for NFR-01 (500 concurrent users) and NFR-04 (< 3 s for common actions).
// Opens CONNECTIONS concurrent keep-alive connections against common read endpoints using
// real signed-in sessions, and reports latency percentiles. Results depend on the hardware
// it runs on — report the measured numbers, never assume them.
// Usage: BASE_URL=http://localhost:4000 CONNECTIONS=500 DURATION=20 node scripts/loadtest.js
import autocannon from 'autocannon';

const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 500);
const DURATION = Number(process.env.DURATION ?? 20);
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo@1234';

async function session(username) {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'hms' }, body: JSON.stringify({ username, password: PASSWORD }) });
  if (!res.ok) throw new Error(`login ${username} failed: ${res.status}`);
  return res.headers.get('set-cookie').split(';')[0];
}

const scenarios = [
  { name: 'Receptionist: patient search', user: 'reception', path: '/api/patients?q=ali&pageSize=20' },
  { name: "Receptionist: today's appointments", user: 'reception', path: '/api/appointments?pageSize=50' },
  { name: 'Receptionist: live bed board', user: 'reception', path: '/api/wards/board' },
  { name: 'Doctor: dashboard', user: 'dr.ahmed', path: '/api/reports/dashboard' },
  { name: 'Pharmacist: prescription queue', user: 'pharmacist', path: '/api/pharmacy/prescriptions' },
];

const results = [];
for (const s of scenarios) {
  const cookie = await session(s.user);
  const r = await autocannon({ url: `${BASE}${s.path}`, connections: CONNECTIONS, duration: DURATION, headers: { cookie, 'X-HMS-Background': '1' } });
  results.push({
    scenario: s.name, requests: r.requests.total, 'req/s': Math.round(r.requests.average), 'p50 ms': r.latency.p50, 'p97.5 ms': r.latency.p97_5, 'p99 ms': r.latency.p99,
    'max ms': r.latency.max, errors: r.errors + r.timeouts, non2xx: r.non2xx, 'under 3 s (p99)': r.latency.p99 < 3000 ? 'yes' : 'NO',
  });
  console.log(`${s.name}: done`);
}
console.table(results);
console.log(`\n${CONNECTIONS} concurrent connections, ${DURATION}s per scenario, single Node.js process, against ${BASE}.`);
