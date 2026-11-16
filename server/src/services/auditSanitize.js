const SENSITIVE_KEYS = /password|passwd|secret|token|credential|authorization|cookie/i;

export function sanitizeAuditDetails(value) {
  if (Array.isArray(value)) return value.map(sanitizeAuditDetails);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SENSITIVE_KEYS.test(key) ? '[REDACTED]' : sanitizeAuditDetails(child);
  }
  return result;
}
