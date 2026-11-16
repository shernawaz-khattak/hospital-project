import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';
import { useToast } from '../components/ui.jsx';

/** GET query. `key` defaults to the path, so invalidating by path prefix works. */
export function useApi(path, { enabled = true, background = false, refetchInterval, keepPrevious = true, key } = {}) {
  return useQuery({
    queryKey: key ?? ['api', ...String(path).split('?')[0].split('/').filter(Boolean), path],
    queryFn: ({ signal }) => api(path, { signal, background }),
    enabled: enabled && Boolean(path),
    refetchInterval,
    placeholderData: keepPrevious ? (prev) => prev : undefined,
  });
}

/**
 * Mutation with consistent feedback: success toast, error toast (unless the form shows the
 * error inline), and invalidation of the affected API areas, e.g. invalidate: ['patients'].
 */
export function useAction(fn, { success, invalidate = [], onSuccess, onError, quietErrors = false } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (data, vars) => {
      await Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: ['api', ...k.split('/')] })));
      const msg = typeof success === 'function' ? success(data, vars) : success;
      if (msg) toast({ tone: 'ok', title: msg });
      onSuccess?.(data, vars);
    },
    onError: (err, vars) => {
      const handled = onError?.(err, vars);
      if (!quietErrors && !handled && !(err.fields && Object.keys(err.fields).length)) toast({ tone: 'alert', title: 'Action not completed', message: err.message });
      else if (!quietErrors && !handled) toast({ tone: 'alert', title: err.message });
    },
  });
}
