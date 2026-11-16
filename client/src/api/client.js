// HTTP client for the HMS API. Sends the session cookie and the CSRF header, and turns
// error responses into ApiError objects carrying the server's field-level messages.
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || 'Something went wrong. Please try again.');
    this.status = status;
    this.code = body?.error?.code;
    this.fields = body?.error?.fields || {};
    this.details = body?.error?.details;
  }
}

const listeners = new Set();
/** Subscribe to authentication failures (expired session, sign-out elsewhere). */
export const onAuthError = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();

function apiUrl(path) {
  if (!import.meta.env.PROD) return `/api${path}`;

  if (!configuredApiBaseUrl) {
    throw new ApiError(0, {
      error: {
        message: 'API is not configured. Set VITE_API_BASE_URL to the HMS backend URL.',
        code: 'API_CONFIG',
      },
    });
  }

  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(configuredApiBaseUrl);
  } catch {
    throw new ApiError(0, {
      error: {
        message: 'API configuration is invalid. VITE_API_BASE_URL must be a valid HTTP or HTTPS backend URL.',
        code: 'API_CONFIG',
      },
    });
  }

  if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) {
    throw new ApiError(0, {
      error: {
        message: 'API configuration is invalid. VITE_API_BASE_URL must use HTTP or HTTPS.',
        code: 'API_CONFIG',
      },
    });
  }

  const baseUrl = parsedBaseUrl.toString().replace(/\/+$/, '');
  const apiPath = `/${String(path).replace(/^\/+/, '')}`;
  const url = /\/api$/i.test(baseUrl) ? `${baseUrl}${apiPath}` : `${baseUrl}/api${apiPath}`;

  try {
    return new URL(url).toString();
  } catch {
    throw new ApiError(0, {
      error: {
        message: 'API configuration is invalid. VITE_API_BASE_URL must be a valid backend URL.',
        code: 'API_CONFIG',
      },
    });
  }
}

export async function api(path, { method = 'GET', body, background = false, raw = false, signal } = {}) {
  const headers = { 'X-Requested-With': 'hms' };
  if (background) headers['X-HMS-Background'] = '1';
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const url = apiUrl(path);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: payload,
      credentials: import.meta.env.PROD ? 'include' : 'same-origin',
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, { error: { message: 'Cannot reach the server. Check your network connection.', code: 'NETWORK' } });
  }
  if (raw && res.ok) return res;
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    if (res.status === 401 && !path.startsWith('/auth/login')) listeners.forEach((fn) => fn(err));
    throw err;
  }
  return data;
}

export const get = (p, o) => api(p, o);
export const post = (p, body) => api(p, { method: 'POST', body });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const patch = (p, body) => api(p, { method: 'PATCH', body });
export const del = (p, body) => api(p, { method: 'DELETE', body });

/** Build a query string from an object, skipping empty values. */
export const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj ?? {})) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** Opens a protected file (lab report, PDF) in a new tab via a blob URL. */
export async function openFile(path, { download } = {}) {
  const res = await api(path, { raw: true });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  if (download) {
    const a = document.createElement('a');
    a.href = url;
    a.download = download;
    a.click();
  } else {
    window.open(url, '_blank', 'noopener');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
