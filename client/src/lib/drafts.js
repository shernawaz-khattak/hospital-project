// Draft autosave (SRS UC-02: "All unsaved data must be auto saved before logout").
// Long forms register a flush function; drafts are stored server-side (encrypted) per user.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';

const registry = new Map();

export async function flushAllDrafts() {
  await Promise.allSettled([...registry.values()].map((fn) => fn()));
}

/**
 * useDraft(key, values, { enabled, onRestore })
 * Returns { draft, restore, discard, clear } — `draft` is a saved draft found at mount.
 */
export function useDraft(key, values, { enabled = true, isEmpty } = {}) {
  const [draft, setDraft] = useState(null);
  const latest = useRef(values);
  const dirty = useRef(false);
  const first = useRef(true);
  latest.current = values;

  useEffect(() => {
    if (!enabled || !key) return;
    api(`/drafts/${encodeURIComponent(key)}`, { background: true }).then((r) => setDraft(r.draft)).catch(() => {});
  }, [key, enabled]);

  const save = useCallback(async () => {
    if (!enabled || !key || !dirty.current) return;
    if (isEmpty?.(latest.current)) return;
    dirty.current = false;
    await api(`/drafts/${encodeURIComponent(key)}`, { method: 'PUT', body: { data: latest.current }, background: true }).catch(() => { dirty.current = true; });
  }, [key, enabled, isEmpty]);

  useEffect(() => {
    if (first.current) { first.current = false; return undefined; }
    dirty.current = true;
    const t = setTimeout(save, 4000);
    return () => clearTimeout(t);
  }, [values, save]);

  useEffect(() => {
    if (!key) return undefined;
    registry.set(key, save);
    const onHide = () => save();
    window.addEventListener('pagehide', onHide);
    return () => {
      registry.delete(key);
      window.removeEventListener('pagehide', onHide);
    };
  }, [key, save]);

  const clear = useCallback(async () => {
    dirty.current = false;
    setDraft(null);
    if (key) await api(`/drafts/${encodeURIComponent(key)}`, { method: 'DELETE', background: true }).catch(() => {});
  }, [key]);

  return { draft, discard: clear, clear, dismiss: () => setDraft(null) };
}
