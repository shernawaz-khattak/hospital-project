// In-memory request timing used by the System Health page (NFR-04: < 3 s responses).
// Values are measured, not assumed.
const WINDOW = 2000;
const durations = [];
let total = 0;
let errors5xx = 0;
const startedAt = Date.now();

export function requestMetrics(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    if (req.path === '/api/events') return; // long-lived stream
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    durations.push(ms);
    if (durations.length > WINDOW) durations.shift();
    total += 1;
    if (res.statusCode >= 500) errors5xx += 1;
  });
  next();
}

export function metricsSnapshot() {
  const sorted = [...durations].sort((a, b) => a - b);
  const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
  const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
  return {
    totalRequests: total,
    serverErrors: errors5xx,
    sampleSize: sorted.length,
    avgMs: Math.round(avg * 10) / 10,
    p50Ms: Math.round(pct(50) * 10) / 10,
    p95Ms: Math.round(pct(95) * 10) / 10,
    maxMs: Math.round((sorted.at(-1) ?? 0) * 10) / 10,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  };
}
